#!/usr/bin/env node
// Activity shows everything that changed (Work OS note e56029b458, rule 6): the State `log` entries of the last 14 days,
// written before the feed had State rows, become rows in `activity`, once. Older history stays where it is.
//
//   node scripts/migrate-activity.mjs --db <database>           dry run (the default): counts what it would write
//   node scripts/migrate-activity.mjs --db <database> --apply   writes the rows
//   --days <n>   how far back (default 14, at most 30)
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Prints counts only, never text.
//
// What a row gets, from the State document and its log entry (the log keeps who, how and which op, not the text):
//   - placement: the State's own (orgId, ownerId, visibility, sharedWith), so the door shows the row to exactly the
//     project's readers, and projectId, so the app moves it with the project like every other State row;
//   - text: the line the op wrote when the State still holds it (a Next or Later line, a decision or Now, matched by
//     its time and author); a line done or dropped since has no text left, and its row says only what happened;
//   - who: the log's person, as the app (via app), Claude (chat), Claude Code (code) or Discord.
// Idempotent: each row's id is made from the State, the entry's time and its place in the log, inserted only when
// missing. Entries at or after a project's first State row in the feed are skipped (the app wrote those already).
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const val = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const source = val('--db');
const APPLY = args.includes('--apply');
const DAYS = Math.min(30, Math.max(1, Number(val('--days') ?? 14) || 14));
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node scripts/migrate-activity.mjs --db <database> [--apply] [--days 14]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const TYPE = { set_now: 'state_now', add_next: 'next_added', done_next: 'next_done', add_later: 'later_added', add_decision: 'decision' };
const clip = (t, n = 140) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};
const actorOf = e =>
  e.via === 'chat' ? { kind: 'agent', agent: 'claude', userId: e.by } : e.via === 'code' ? { kind: 'agent', agent: 'claude-code', userId: e.by } : e.via === 'discord' ? { kind: 'discord', userId: e.by } : { kind: 'user', userId: e.by };
const placeOf = d => ({ ownerId: d.ownerId, visibility: d.visibility, sharedWith: d.visibility === 'members' ? [...new Set([d.ownerId, ...(d.sharedWith ?? [])])] : [] });

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  const states = db.collection('states');
  const activity = db.collection('activity');
  const since = new Date(Date.now() - DAYS * 86_400_000);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}, State log entries since ${since.toISOString().slice(0, 10)}\n`);
  const counts = { states: 0, entries: 0, withText: 0, already: 0, newer: 0, written: 0, skippedOps: 0 };
  for await (const st of states.find({ 'log.at': { $gte: since } }, { projection: { orgId: 1, ownerId: 1, visibility: 1, sharedWith: 1, projectId: 1, now: 1, next: 1, later: 1, decisions: 1, log: 1 } })) {
    if (!st.orgId || !st.ownerId || !st.visibility || !st.projectId) continue; // not placed: never written as a row
    counts.states++;
    // The app writes State rows from its first save after the change; anything from then on is already in the feed.
    const first = await activity.findOne({ orgId: st.orgId, projectId: st.projectId, 'subject.kind': 'state', migratedFrom: { $exists: false } }, { sort: { at: 1 }, projection: { at: 1 } });
    // Lines written at one time by one person, in the order the State holds them (one save_state call shares a time).
    const pool = (list, at, by) => (list ?? []).filter(l => l.at?.getTime?.() === at.getTime() && l.by === by);
    const used = new Set();
    const take = (list, at, by) => {
      const l = pool(list, at, by).find(x => !used.has(x.id ?? x));
      if (l) used.add(l.id ?? l);
      return l;
    };
    const ops = [];
    for (const [i, e] of (st.log ?? []).entries()) {
      if (!(e.at >= since)) continue;
      const type = TYPE[e.op];
      if (!type) {
        counts.skippedOps++;
        continue;
      }
      counts.entries++;
      if (first && e.at >= first.at) {
        counts.newer++;
        continue;
      }
      let text = '';
      if (e.op === 'set_now' && st.now && st.now.at?.getTime() === e.at.getTime() && st.now.by === e.by) text = st.now.text;
      else if (e.op === 'add_next') text = take(st.next, e.at, e.by)?.text ?? '';
      else if (e.op === 'add_later') text = take(st.later, e.at, e.by)?.text ?? '';
      else if (e.op === 'add_decision') text = take(st.decisions, e.at, e.by)?.text ?? '';
      if (text) counts.withText++;
      const _id = `statelog:${st._id}:${e.at.getTime()}:${i}`;
      ops.push({
        updateOne: {
          filter: { _id },
          update: {
            $setOnInsert: {
              orgId: st.orgId,
              ...placeOf(st),
              projectId: st.projectId,
              subject: { kind: 'state', id: st.projectId, title: 'State' },
              at: e.at,
              actor: actorOf(e),
              type,
              ...(text ? { note: clip(text) } : {}),
              ...(e.src ? { session: String(e.src).slice(0, 80) } : {}),
              migratedFrom: 'state-log',
            },
          },
          upsert: true,
        },
      });
    }
    if (!ops.length) continue;
    const ids = ops.map(o => o.updateOne.filter._id);
    const have = await activity.countDocuments({ _id: { $in: ids } });
    counts.already += have;
    if (APPLY) counts.written += (await activity.bulkWrite(ops, { ordered: false })).upsertedCount;
  }
  console.log(`  States with log entries in the window: ${counts.states}`);
  console.log(`  Entries that make a row (set_now, add_next, done_next, add_later, add_decision): ${counts.entries}, of which with their text still in the State: ${counts.withText}`);
  console.log(`  Already in the feed (the app wrote them): ${counts.newer}; rows from an earlier run of this script: ${counts.already}`);
  console.log(`  Other ops (move_next, set_where, edit_line, promote_later, archive_decision): ${counts.skippedOps}, no row`);
  console.log(APPLY ? `  ✓ ${counts.written} rows written` : `  - ${counts.entries - counts.newer - counts.already} rows would be written`);
  if (!APPLY) console.log('\nDry run: nothing was changed.');
} finally {
  await client.close();
}
