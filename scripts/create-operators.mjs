#!/usr/bin/env node
// Step 1 of the cut-over (docs/hosting.md): an account for every address in OPERATOR_EMAILS, before anything else.
//
// Why first: the operator is recognised by email (lib/operator.ts). An invitation marks the invitee's email verified,
// so if an owner or admin invited an operator address that had no account yet, whoever accepted that invitation would
// be the operator. With the accounts made here first, an invitation to such an address can only be accepted by the
// person who already owns it (they sign in first, then Join).
//
//   node scripts/create-operators.mjs --db <database>           dry run: says what it would do
//   node scripts/create-operators.mjs --db <database> --apply   creates the missing accounts
//
// Accounts are made with no password and no organization: the person sets a password with "Forgot password?" on
// /login. OWNER_EMAIL gets OWNER_NAME (default "Om"); everyone else the part of the address before the @.
// migrate-auth.mjs then finds OWNER_EMAIL's account and makes it owner of the organization.
//
// Environment: MONGODB_URI (or a MONGO_*_URI name), OPERATOR_EMAILS, BETTER_AUTH_SECRET (or SESSION_SECRET), APP_URL,
// optional OWNER_EMAIL and OWNER_NAME. The database is never taken from the environment. Idempotent. Prints addresses
// (they are in OPERATOR_EMAILS already), never secrets.
import { MongoClient } from 'mongodb';
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
if (!dbName) die('Name the database: node scripts/create-operators.mjs --db <database> [--apply]');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emails = [...new Set((process.env.OPERATOR_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean))];
if (!emails.length) die('OPERATOR_EMAILS is empty: set it to the operator addresses (comma list) first.');
const bad = emails.filter(e => !EMAIL.test(e));
if (bad.length) die(`OPERATOR_EMAILS has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that is not an email address.`);
const secret = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET || '';
if (secret.length < 32) die('BETTER_AUTH_SECRET (or SESSION_SECRET) must be set, 32+ characters, the same as the app uses.');
const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase() || '';
const ownerName = process.env.OWNER_NAME?.trim() || 'Om';
if (ownerEmail && !emails.includes(ownerEmail)) console.log(`  ! OWNER_EMAIL is not in OPERATOR_EMAILS: the owner will not see health, Usage or Discord registration.`);

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const host = uri.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${dbName}" at ${host}\n`);
  const admin = authAdmin({ db, client, secret, baseURL: process.env.APP_URL || 'http://localhost' });
  // Better Auth's invitations collection: an operator address with a pending invitation is worth knowing about.
  const pending = await db.collection('invitation').countDocuments({ email: { $in: emails }, status: 'pending' }).catch(() => 0);
  for (const email of emails) {
    const user = await admin.findUser(email);
    if (user) {
      console.log(`  = ${email} has an account`);
      continue;
    }
    const name = email === ownerEmail ? ownerName : email.split('@')[0];
    if (APPLY) {
      await admin.createUser({ email, name });
      console.log(`  ✓ created ${email} (no password yet)`);
    } else console.log(`  - would create ${email} (no password)`);
  }
  if (pending) console.log(`\n  ! ${pending} pending invitation(s) to an operator address: cancel them in Settings › Members unless you sent them.`);
} finally {
  await client.close();
}
