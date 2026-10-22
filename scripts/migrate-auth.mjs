#!/usr/bin/env node
// Moves Work OS from the single password to sign-in by user (docs/auth.md, phase 1 of docs/multi-user.md).
//
//   node scripts/migrate-auth.mjs --db <database>                 dry run: says what it would do, changes nothing
//   node scripts/migrate-auth.mjs --db <database> --apply         does it
//   node scripts/migrate-auth.mjs --db <database> --apply --drop-old   also deletes the old auth data (see 5)
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it), OWNER_EMAIL (Om's address), optional
// OWNER_NAME (default "Om"), BETTER_AUTH_SECRET (or SESSION_SECRET), APP_URL. The database name is never taken from
// the environment: --db must name it, so the script can't run against the wrong one by accident.
//
// Idempotent: run it again and it changes nothing that is already done.
//   1. Om as the first user (OWNER_EMAIL), with no password: he sets one with "Forgot password?" on /login
//      (the old password is not carried over).
//   2. The organization "Delpat" (slug delpat), with Om as owner.
//   3. Old Claude Code keys (apiKeys) and computers (devices without an owner) are listed. They can't be moved
//      (only hashes were stored, and keys now belong to a user): with --apply the computers are revoked and
//      Settings shows "re-create your keys and re-link the worker" once (settings _id 'authMigration').
//   4. MCP_TOKEN is no longer read: create a Claude chat key in Settings › Connections and update the connector.
//   5. --drop-old deletes the old auth collections (apiKeys, passkeys, authChallenges, authFailures, passwordResets)
//      and the settings doc 'security' (old password hash, TOTP secret, recovery codes). Not needed for anything.
import { MongoClient } from 'mongodb';
import { authAdmin } from './lib/auth-admin.mjs';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const dbName = (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : null;
})();
const APPLY = flag('--apply');
const DROP = flag('--drop-old');

function die(msg) {
  console.error(msg);
  process.exit(2);
}
if (!dbName || dbName.startsWith('--')) die('Name the database: node scripts/migrate-auth.mjs --db <database> [--apply] [--drop-old]');
if (DROP && !APPLY) die('--drop-old needs --apply.');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) die('OWNER_EMAIL must be set to Om\'s email address.');
const ownerName = process.env.OWNER_NAME?.trim() || 'Om';
const secret = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET || '';
if (secret.length < 32) die('BETTER_AUTH_SECRET (or SESSION_SECRET) must be set, 32+ characters, the same as the app uses.');

const ORG = { name: 'Delpat', slug: 'delpat' };
const say = (done, todo) => console.log(`${APPLY ? '  ✓' : '  -'} ${APPLY ? done : todo}`);

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const host = uri.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${dbName}" at ${host}\n`);
  const admin = authAdmin({ db, client, secret, baseURL: process.env.APP_URL || 'http://localhost' });

  // 1. Om
  let user = await admin.findUser(ownerEmail);
  if (user) console.log(`  = user ${ownerEmail} exists (${user.id})`);
  else if (APPLY) {
    const id = await admin.createUser({ email: ownerEmail, name: ownerName });
    user = { id };
    say(`created user ${ownerEmail} (${id}), no password yet`, '');
  } else say('', `would create user ${ownerEmail} (${ownerName}), no password`);

  // 2. Delpat, Om as owner
  let org = await admin.findOrg(ORG.slug);
  if (org) console.log(`  = organization ${org.name} exists (${org.id})`);
  else if (APPLY) {
    org = { id: await admin.createOrg(ORG), ...ORG };
    say(`created organization ${ORG.name} (${org.id})`, '');
  } else say('', `would create organization ${ORG.name}`);
  if (user && org) {
    const role = await admin.memberRole(user.id, org.id);
    if (role === 'owner') console.log(`  = ${ownerEmail} is owner of ${org.name}`);
    else if (role) console.log(`  ! ${ownerEmail} is ${role} of ${org.name}, not owner: left as is`);
    else if (APPLY) {
      await admin.addMember({ userId: user.id, orgId: org.id, role: 'owner' });
      say(`${ownerEmail} is now owner of ${org.name}`, '');
    }
  } else if (!APPLY) say('', `would make ${ownerEmail} owner of ${ORG.name}`);

  // 3. Old keys and computers
  const oldKeys = (await db.collection('apiKeys').find({ revokedAt: null }).toArray()).map(k => ({ name: k.name, prefix: k.prefix }));
  const oldDeviceDocs = await db.collection('devices').find({ revokedAt: null, ownerId: { $exists: false } }).toArray();
  const oldDevices = oldDeviceDocs.map(d => ({ name: d.name, prefix: d.prefix }));
  console.log(`\n  Old Claude Code keys (stop working; re-create in Claude › Setup): ${oldKeys.length ? oldKeys.map(k => `${k.name} [${k.prefix}…]`).join(', ') : 'none'}`);
  console.log(`  Old computers (re-add in Claude › Setup, new device key in the worker config): ${oldDevices.length ? oldDevices.map(d => `${d.name} [${d.prefix}…]`).join(', ') : 'none'}`);
  const notice = await db.collection('settings').findOne({ _id: 'authMigration' });
  if (notice) console.log('  = the Settings notice was already written');
  else if (APPLY) {
    await db.collection('settings').insertOne({ _id: 'authMigration', oldKeys, oldDevices, migratedAt: new Date(), dismissedAt: null });
    say('Settings will show "re-create your keys and re-link the worker" once', '');
  } else say('', 'would write the one-time Settings notice');
  if (oldDeviceDocs.length) {
    if (APPLY) {
      const now = new Date();
      const ids = oldDeviceDocs.map(d => d._id);
      await db.collection('devices').updateMany({ _id: { $in: ids }, revokedAt: null }, { $set: { revokedAt: now } });
      await db.collection('workerJobs').updateMany({ deviceId: { $in: ids }, doneAt: null }, { $set: { doneAt: now, ok: false, error: 'device revoked (sign-in by user)' } });
      say(`revoked ${ids.length} old computer${ids.length === 1 ? '' : 's'} (their folders and session history stay)`, '');
    } else say('', `would revoke ${oldDeviceDocs.length} old computer(s)`);
  }

  // 5. Old auth data
  const OLD = ['apiKeys', 'passkeys', 'authChallenges', 'authFailures', 'passwordResets'];
  const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => OLD.includes(n));
  const security = await db.collection('settings').findOne({ _id: 'security' });
  if (DROP) {
    for (const n of present) await db.collection(n).drop().catch(() => {});
    if (security) await db.collection('settings').deleteOne({ _id: 'security' });
    console.log(`\n  ✓ deleted old auth data: ${[...present, ...(security ? ["settings 'security'"] : [])].join(', ') || 'nothing left'}`);
  } else if (present.length || security) {
    console.log(`\n  Old auth data still there (unused; --apply --drop-old deletes it): ${[...present, ...(security ? ["settings 'security'"] : [])].join(', ')}`);
  }

  console.log(`\nNext:
  - Om: open ${process.env.APP_URL || '<APP_URL>'}/login → "Forgot password?" → ${ownerEmail}, set a password from the email.
  - Settings › Connections: create a Claude chat key; update the claude.ai connector (MCP_TOKEN no longer works).
  - Claude › Setup: create Claude Code keys and add each computer again.
  - Remove APP_PASSWORD and MCP_TOKEN from the server's environment.`);
} finally {
  await client.close();
}
