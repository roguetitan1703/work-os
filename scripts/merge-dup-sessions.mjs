#!/usr/bin/env node
// One Claude session, one Work OS id (plan note db5bf91389, piece B4). Before ids were stable a Claude Code session got a new id at
// every start, so one session left several open rows. This merges them: the work of the older rows (Needs, unread messages, holds,
// slot holds, builders' parent, claimed items, handovers, doing) moves to the newest row, and the older rows end and point at it.
//
//   node --experimental-strip-types --no-warnings scripts/merge-dup-sessions.mjs --db <database> [--org <orgId>]            dry run: the groups and what they hold
//   node --experimental-strip-types --no-warnings scripts/merge-dup-sessions.mjs --db <database> [--org <orgId>] --apply    merges, and deletes the token rows of the merged ids
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is always named on the command line.
// A group is the open hook rows with one userId + Claude Code session + project + computer. A row seen in the last 30 minutes is skipped
// on its own (it may be live); the rest of its group still merges into the newest row. A group on no project only ends the older rows
// (nothing is filed there to move). A row whose own id is the session record id (agentIdentities _id) of ANOTHER Claude Code session is
// never ended or merged: it is skipped and logged. The move is lib/session-move.ts, the code the app runs at sign-in. A second --apply finds nothing.
// Prints counts only, never any text.
import { MongoClient } from 'mongodb';
import { copySeenBy, moveOwnedWork, moveSessionWork } from '../lib/session-move.ts';

const args = process.argv.slice(2);
const val = f => (args.indexOf(f) >= 0 && args[args.indexOf(f) + 1] && !args[args.indexOf(f) + 1].startsWith('--') ? args[args.indexOf(f) + 1] : null);
const source = val('--db');
const onlyOrg = val('--org');
const APPLY = args.includes('--apply');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node --experimental-strip-types scripts/merge-dup-sessions.mjs --db <database> [--org <orgId>] [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
const RECENT_MS = 30 * 60_000;

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  const cols = Object.fromEntries(['needs', 'messages', 'states', 'stateParked', 'tasks', 'slots', 'presence', 'claudeItems', 'notes'].map(n => [n, db.collection(n)]));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}${onlyOrg ? ` (organization ${onlyOrg})` : ''}\n`);
  const rows = await cols.presence
    .find({ ccSession: { $exists: true, $ne: '' }, session: { $exists: true }, endedAt: { $exists: false }, movedTo: { $exists: false }, ...(onlyOrg ? { orgId: onlyOrg } : {}) })
    .toArray();
  const seenAt = r => (r.lastSeen ? new Date(r.lastSeen).getTime() : 0); // a row with no lastSeen counts as the oldest
  const groups = new Map();
  for (const r of rows) {
    const k = [r.userId, r.ccSession, r.projectId ?? 'none', r.machine ?? ''].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const now = Date.now();
  let nGroups = 0;
  let nRows = 0;
  let nSkipped = 0;
  let tokens = 0;
  const identities = new Map(); // ownerId|device|ccSession -> the session record's id (that id is never merged away and its tokens never deleted)
  const identityOf = async r => {
    const k = [r.userId, r.machine ?? '', r.ccSession].join('|');
    if (!identities.has(k)) identities.set(k, (await db.collection('agentIdentities').findOne({ ownerId: r.userId, deviceId: r.machine, ccSessions: r.ccSession }, { projection: { _id: 1 } }))?._id ?? null);
    return identities.get(k);
  };
  const isIdentity = async id => !!(await db.collection('agentIdentities').findOne({ _id: id }, { projection: { _id: 1 } }));
  // A row whose own id is the record id of ANOTHER Claude Code session is that session's row (the group's ccSession is not its): never ended, never merged.
  const foreignIdentity = async (r, idSid) => !!r.session && r.session !== idSid && (await isIdentity(r.session));
  const tokenFilter = id => ({ $or: [{ sessionId: id }, { _id: id }] });
  let tokensToDelete = 0;
  const total = { needs: 0, messages: 0, lines: 0, slots: 0, parents: 0, claims: 0, handovers: 0 };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => seenAt(b) - seenAt(a)); // newest first
    // The row of the session record's own id is kept when it is there (its tokens stay valid); else the newest.
    const idSid = await identityOf(g[0]);
    const keep = (idSid && g.find(r => r.session === idSid)) || g[0];
    if (await foreignIdentity(keep, idSid)) {
      console.log(`  skipped a group of project ${keep.projectId ?? 'none'}: its row ${keep.session} is the session record of another Claude Code session`);
      nSkipped++;
      continue;
    }
    const older = g.filter(r => r !== keep);
    nGroups++;
    for (const from of older) {
      if (await foreignIdentity(from, idSid)) {
        console.log(`  skipped a row of project ${from.projectId ?? 'none'}: its id ${from.session} is the session record of another Claude Code session`);
        nSkipped++;
        continue;
      }
      if (now - seenAt(from) < RECENT_MS) {
        nSkipped++;
        continue;
      }
      const fk = `${from.userId}:${from.key}`;
      const needsOpen = from.projectId ? await cols.needs.countDocuments({ projectId: from.projectId, 'from.session': from.session, status: { $in: ['open', 'answered'] }, briefedAt: { $exists: false } }) : 0;
      const unread = await cols.messages.countDocuments({ projectId: from.projectId ?? null, toSids: fk, status: { $in: ['unread', 'seen'] } });
      const toks = (await isIdentity(from.session)) ? 0 : await db.collection('agentSessions').countDocuments(tokenFilter(from.session));
      nRows++;
      if (!APPLY) {
        tokensToDelete += toks;
        console.log(`  would merge a row of project ${from.projectId ?? 'none'} into the newest of its session (needs open: ${needsOpen}, messages addressed: ${unread})`);
        continue;
      }
      // The row's tokens go first, one row at a time: a crash after this leaves the row open, and a rerun merges it (nothing is left half done).
      if (toks) tokens += (await db.collection('agentSessions').deleteMany(tokenFilter(from.session))).deletedCount;
      if (from.projectId) {
        const m = await moveSessionWork(cols, from.projectId, from, keep, now);
        for (const k of Object.keys(total)) total[k] += m[k] ?? 0;
      } else {
        // Filed nowhere: its unread messages (no project) and read marks follow; nothing else is held there.
        await moveOwnedWork(cols, null, from, keep);
        await copySeenBy(cols, null, from, keep);
        await cols.presence.updateOne({ _id: from._id }, { $set: { movedTo: keep.key, swept: new Date(now), endedAt: new Date(now) } });
      }
    }
  }
  console.log(`\n${nGroups} group(s) with more than one open row; ${nRows} row(s) ${APPLY ? 'merged' : 'to merge'}, ${nSkipped} skipped (seen in the last 30 minutes, or the record of another session).`);
  if (!APPLY) console.log(`Token rows --apply would delete: ${tokensToDelete}.`);
  if (APPLY) console.log(`Moved: ${total.needs} Needs, ${total.messages} messages, ${total.lines} lines, ${total.slots} slot holds, ${total.parents} parents, ${total.claims} claimed items, ${total.handovers} handovers. Token rows deleted: ${tokens}.`);
} finally {
  await client.close();
}
