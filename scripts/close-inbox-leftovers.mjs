#!/usr/bin/env node
// The personal inbox (Messages for you) is gone (21 Nov). A message stored for a person (toUser) that is still unread or seen
// is closed: status `seen`, note "inbox removed 21 Nov", closedAt now. Nothing reads toUser any more; this only tidies the rows.
//
//   node scripts/close-inbox-leftovers.mjs --db <database>           dry run: prints the count and the ids
//   node scripts/close-inbox-leftovers.mjs --db <database> --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: a row with a closedAt of this script is not touched again. Prints ids only, never text.
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const source = args.indexOf('--db') >= 0 && args[args.indexOf('--db') + 1] && !args[args.indexOf('--db') + 1].startsWith('--') ? args[args.indexOf('--db') + 1] : null;
const APPLY = args.includes('--apply');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node scripts/close-inbox-leftovers.mjs --db <database> [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const NOTE = 'inbox removed 21 Nov';
const client = new MongoClient(uri);
await client.connect();
try {
  const messages = client.db(source).collection('messages');
  const filter = { toUser: { $exists: true, $ne: null }, status: { $in: ['unread', 'seen'] }, note: { $ne: NOTE } };
  const rows = await messages.find(filter, { projection: { _id: 1 } }).toArray();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${host(uri)} / ${source}: ${rows.length} inbox message(s) open`);
  if (rows.length) console.log(`ids: ${rows.map(r => r._id).join(', ')}`);
  if (APPLY && rows.length) {
    const r = await messages.updateMany({ _id: { $in: rows.map(x => x._id) } }, { $set: { status: 'seen', note: NOTE, closedAt: new Date() } });
    console.log(`closed ${r.modifiedCount}`);
  } else if (!APPLY) console.log('Nothing changed. Add --apply to close them.');
} finally {
  await client.close();
}
