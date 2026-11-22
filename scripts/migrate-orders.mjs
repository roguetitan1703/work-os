#!/usr/bin/env node
// Step 1 (docs/archive/step-1.md section 2): each organization's existing "Claude Code boilerplate" note becomes its
// organization Orders (the standing rules every AI reads first in start_work).
//
//   node scripts/migrate-orders.mjs --db <database>           dry run: says what it would change
//   node scripts/migrate-orders.mjs --db <database> --apply   marks the notes
//
// Per organization: the earliest live, top-level, shared note titled "Claude Code boilerplate" (any case) is marked
// `orders: 'org'`, with the organization's first owner as the one who holds the layer (`ordersBy`). An organization that
// already has an organization Orders note, or none titled so, or only a private one (Orders for everyone must be readable
// by everyone), is left alone and says why. Idempotent: a second run changes nothing. Environment: MONGODB_URI (or a
// MONGO_*_URI name as the app reads it). The database is never taken from the environment.
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const die = msg => {
  console.error(msg);
  process.exit(2);
};
const source = arg('--db');
const APPLY = args.includes('--apply');
if (!source) die('Name the database: node scripts/migrate-orders.mjs --db <database> [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  const orgs = await db.collection('organization').find({}).sort({ createdAt: 1 }).toArray();
  let changed = 0;
  for (const org of orgs) {
    const id = String(org._id);
    const say = m => console.log(`  ${org.name ?? id}: ${m}`);
    const live = { orgId: id, deletedAt: null, archived: false };
    const has = await db.collection('notes').findOne({ ...live, orders: 'org' }, { projection: { title: 1 } });
    if (has) {
      say(`already has organization Orders ("${has.title}"): nothing to do`);
      continue;
    }
    const cand = await db.collection('notes').find({ ...live, title: { $regex: /^\s*claude code boilerplate\s*$/i }, parentId: null, taskId: null }).sort({ createdAt: 1 }).toArray();
    if (!cand.length) {
      say('no "Claude Code boilerplate" note: nothing to do');
      continue;
    }
    const note = cand.find(n => n.visibility === 'org');
    if (!note) {
      say(`the boilerplate note is not shared with everyone (it is ${cand[0].visibility}): left alone; share it, or mark another page in the app`);
      continue;
    }
    const owner = await db.collection('member').findOne({ organizationId: { $in: [org._id, id] }, role: 'owner' }, { sort: { createdAt: 1 } });
    if (!owner) {
      say('no owner found: left alone');
      continue;
    }
    say(`${APPLY ? 'marking' : 'would mark'} "${note.title}" (${note._id}) as the organization Orders, held by ${owner.userId}${cand.length > 1 ? ` (${cand.length} notes have that title: the earliest shared one)` : ''}`);
    if (APPLY) await db.collection('notes').updateOne({ _id: note._id, orders: { $exists: false } }, { $set: { orders: 'org', ordersBy: String(owner.userId) } });
    changed++;
  }
  console.log(`\n${changed ? `${APPLY ? 'Marked' : 'Would mark'} ${changed} note${changed === 1 ? '' : 's'}.` : 'Nothing to do.'}${APPLY ? '' : ' Dry run: nothing was changed.'}`);
} finally {
  await client.close();
}
