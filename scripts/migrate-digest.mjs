#!/usr/bin/env node
// The daily digest (docs/archive/plan-1-3.md slice 2): a new alert kind `digest`, on by default for everyone. Someone who
// saved their alert switches and has "Due today" off keeps the morning quiet: their `digest` is saved off. Everyone
// else who saved switches gets `digest` saved on (the same as the default, so nothing depends on the default later).
//
//   node scripts/migrate-digest.mjs --db <database>           dry run: counts what it would change
//   node scripts/migrate-digest.mjs --db <database> --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: only switch documents with no saved `digest` change. Prints counts only.
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const source = args.indexOf('--db') >= 0 && args[args.indexOf('--db') + 1] && !args[args.indexOf('--db') + 1].startsWith('--') ? args[args.indexOf('--db') + 1] : null;
const APPLY = args.includes('--apply');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node scripts/migrate-digest.mjs --db <database> [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const client = new MongoClient(uri);
await client.connect();
try {
  const settings = client.db(source).collection('settings');
  const todo = { area: 'notify', 'notify.kinds.digest': { $exists: false } };
  const total = await settings.countDocuments(todo);
  const off = await settings.countDocuments({ ...todo, 'notify.kinds.due_today': false });
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  if (APPLY && total) {
    // One server-side update each: digest follows due_today (on unless it was saved off).
    await settings.updateMany(todo, [{ $set: { 'notify.kinds.digest': { $ne: ['$notify.kinds.due_today', false] } } }]);
  }
  console.log(total ? `  ${APPLY ? '✓' : '-'} ${total} people with saved switches: digest ${APPLY ? 'set' : 'would be set'} on for ${total - off}, off for ${off} (their Due today is off)` : '  Nothing to do: every saved set of switches has the digest.');
  console.log('  (People who never saved switches get the default: digest on.)');
  if (!APPLY) console.log('\nDry run: nothing was changed.');
} finally {
  await client.close();
}
