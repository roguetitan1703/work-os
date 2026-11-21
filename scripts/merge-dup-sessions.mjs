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
// (nothing is filed there to move). The move is lib/session-move.ts, the code the app runs at sign-in. A second --apply finds nothing.
// Prints counts only, never any text.
import { MongoClient } from 'mongodb';
import { moveSessionWork } from '../lib/session-move.ts';

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
    .sort({ lastSeen: -1 })
    .toArray();
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
  const mergedIds = new Set();
  const total = { needs: 0, messages: 0, lines: 0, slots: 0, parents: 0, claims: 0, handovers: 0 };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [keep, ...older] = g; // newest first
    nGroups++;
    for (const from of older) {
      if (now - from.lastSeen.getTime() < RECENT_MS) {
        nSkipped++;
        continue;
      }
      const fk = `${from.userId}:${from.key}`;
      const needsOpen = from.projectId ? await cols.needs.countDocuments({ projectId: from.projectId, 'from.session': from.session, status: { $in: ['open', 'answered'] }, briefedAt: { $exists: false } }) : 0;
      const unread = from.projectId ? await cols.messages.countDocuments({ projectId: from.projectId, toSids: fk, status: { $in: ['unread', 'seen'] } }) : 0;
      nRows++;
      if (!APPLY) {
        console.log(`  would merge a row of project ${from.projectId ?? 'none'} into the newest of its session (needs open: ${needsOpen}, messages addressed: ${unread})`);
        continue;
      }
      if (from.projectId) {
        const m = await moveSessionWork(cols, from.projectId, from, keep, now);
        for (const k of Object.keys(total)) total[k] += m[k] ?? 0;
      } else await cols.presence.updateOne({ _id: from._id }, { $set: { movedTo: keep.key, swept: new Date(now), endedAt: new Date(now) } });
      mergedIds.add(from.session);
    }
  }
  let tokens = 0;
  if (APPLY && mergedIds.size) {
    const ids = [...mergedIds];
    tokens = (await db.collection('agentSessions').deleteMany({ $or: [{ sessionId: { $in: ids } }, { _id: { $in: ids } }] })).deletedCount;
  }
  console.log(`\n${nGroups} group(s) with more than one open row; ${nRows} row(s) ${APPLY ? 'merged' : 'to merge'}, ${nSkipped} skipped (seen in the last 30 minutes).`);
  if (APPLY) console.log(`Moved: ${total.needs} Needs, ${total.messages} messages, ${total.lines} lines, ${total.slots} slot holds, ${total.parents} parents, ${total.claims} claimed items, ${total.handovers} handovers. Token rows deleted: ${tokens}.`);
} finally {
  await client.close();
}
