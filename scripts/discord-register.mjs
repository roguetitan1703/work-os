#!/usr/bin/env node
// Step 5 of the cut-over (docs/hosting.md): registers the Discord commands again in each organization's server, so
// they gain /link and the organization's modes. It calls the running app's own route
// (POST /api/admin/discord/register?org=<id>, operator only) with a temporary Claude chat key of an operator, and
// deletes that key afterwards, so nobody has to sign in and make a key first.
//
//   node scripts/discord-register.mjs --db <database>                         dry run: checks, says what it would do
//   node scripts/discord-register.mjs --db <database> --apply                 registers
//   ... --base http://127.0.0.1:3000                                          the app (default: that)
//
// Environment: MONGODB_URI (or a MONGO_*_URI name), OPERATOR_EMAILS, BETTER_AUTH_SECRET, and the app's Discord
// variables (DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY: only checked for presence here; the app
// reads its own). The database is never taken from the environment. Prints command names, never keys or tokens.
// Organizations with no Discord server set are skipped (the operator sets one in Settings › Connections › Discord,
// then runs this again or uses the curl shown there).
import { MongoClient, ObjectId } from 'mongodb';
import { authAdmin } from './lib/auth-admin.mjs';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const die = msg => {
  console.error(msg);
  process.exit(2);
};

const dbName = arg('--db');
const APPLY = args.includes('--apply');
const base = (arg('--base') || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
if (!dbName) die('Name the database: node scripts/discord-register.mjs --db <database> [--apply] [--base <url>]');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const secret = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET || '';
if (secret.length < 32) die('BETTER_AUTH_SECRET (or SESSION_SECRET) must be set, 32+ characters, the same as the app uses.');
const operators = (process.env.OPERATOR_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
if (!operators.length) die('OPERATOR_EMAILS is empty.');
const missing = ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY'].filter(k => !process.env[k]?.trim());
if (missing.length) die(`Discord is not configured here: ${missing.join(', ')} not set. Nothing to register.`);

const idIn = id => ({ $in: ObjectId.isValid(id) && String(id).length === 24 ? [new ObjectId(id), String(id)] : [String(id)] });

// The app must be up (it does the registering).
const live = await fetch(`${base}/api/live`).then(r => r.status, () => 0);
if (live !== 200) die(`The app does not answer at ${base}/api/live (${live || 'no connection'}): start it first.`);

const client = new MongoClient(uri);
await client.connect();
let failed = 0;
try {
  const db = client.db(dbName);
  const host = uri.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${dbName}" at ${host}, app ${base}\n`);
  const admin = authAdmin({ db, client, secret, baseURL: process.env.APP_URL || 'http://localhost' });
  const opUsers = await db.collection('user').find({ email: { $in: operators } }).project({ _id: 1, email: 1 }).toArray();
  if (!opUsers.length) die('No operator has an account yet: run scripts/create-operators.mjs first.');
  const orgs = await db.collection('organization').find({}).project({ _id: 1, name: 1 }).sort({ createdAt: 1 }).toArray();
  if (!orgs.length) die('No organization yet: run scripts/migrate-auth.mjs first.');
  for (const org of orgs) {
    const orgId = String(org._id);
    const guild = await db.collection('settings').findOne({ _id: `discord:${orgId}` });
    if (!guild?.guildId) {
      console.log(`  · ${org.name}: no Discord server set, skipped`);
      continue;
    }
    // An operator who is a member there: the key must belong to someone in the organization (lib/caller.ts verifyKey).
    const member = await db.collection('member').findOne({ organizationId: idIn(orgId), userId: { $in: opUsers.flatMap(u => [u._id, String(u._id)]) } });
    if (!member) {
      console.log(`  ! ${org.name}: no operator is a member, so no key can act there; register from Settings once one is`);
      failed++;
      continue;
    }
    if (!APPLY) {
      console.log(`  - ${org.name}: would register the commands in its server`);
      continue;
    }
    const { key, id } = await admin.createKey({ userId: String(member.userId), orgId, agent: 'claude', name: 'cut-over: Discord commands (temporary)' });
    try {
      const r = await fetch(`${base}/api/admin/discord/register?org=${encodeURIComponent(orgId)}`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) console.log(`  ✓ ${org.name}: registered ${(j.registered ?? []).map(c => c.name).join(', ')}`);
      else {
        failed++;
        console.log(`  ✗ ${org.name}: ${r.status} ${typeof j.error === 'string' ? j.error.slice(0, 200) : ''}`);
      }
    } finally {
      await db.collection('apikey').deleteOne({ _id: idIn(id) });
    }
  }
} finally {
  await client.close();
}
if (failed) {
  console.error(`\n${failed} organization(s) not registered.`);
  process.exit(1);
}
