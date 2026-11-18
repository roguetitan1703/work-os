#!/usr/bin/env node
// Makes a Claude Code key for a person straight in the database, without the app's "confirm it is you" step, and
// writes it into this PC's Claude Code settings (env WORK_OS_KEY) for the Work OS hooks. The key is never printed.
// For the owner on their own PC: whoever can run this already holds the database credentials.
//
//   node scripts/make-key.mjs --db <database> --email <person> --name "Hooks · <pc>"            dry run
//   node scripts/make-key.mjs --db <database> --email <person> --name "Hooks · <pc>" --apply    create + write
//
// Environment: MONGODB_URI, SESSION_SECRET (or BETTER_AUTH_SECRET). The key is stored the way the app stores it
// (scripts/lib/auth-admin.mjs: Better Auth's hasher, prefix wos_, agent claude-code, the person's organization), so it
// shows in Claude › Set up › Access keys under that name and can be revoked there. ~/.claude/settings.json gets a dated
// backup first; ~/.claude.json is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { authAdmin } from './lib/auth-admin.mjs';

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const die = m => { console.error(m); process.exit(2); };
const dbName = arg('--db');
const email = arg('--email');
const name = arg('--name');
const APPLY = args.includes('--apply');
if (!dbName || !email || !name) die('usage: node scripts/make-key.mjs --db <database> --email <person> --name "Hooks · <pc>" [--apply]');
const uri = process.env.MONGODB_URI;
const secret = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET;
if (!uri || !secret) die('MONGODB_URI and SESSION_SECRET (or BETTER_AUTH_SECRET) must be set.');

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const admin = authAdmin({ db, client, secret });
  const user = await admin.findUser(email);
  if (!user) die('No account with that email in this database.');
  const ids = [String(user.id), ...(ObjectId.isValid(String(user.id)) ? [new ObjectId(String(user.id))] : [])];
  const members = await db.collection('member').find({ userId: { $in: ids } }).toArray();
  if (members.length !== 1) die(`That person is in ${members.length} organizations; this script handles exactly one.`);
  const orgId = String(members[0].organizationId);
  const org = await db.collection('organization').findOne({ $or: [{ _id: members[0].organizationId }, { _id: orgId }] });
  console.log(`person found, organization: ${org?.name ?? orgId}, key name: ${name}`);
  if (!APPLY) { console.log('dry run: nothing created (add --apply)'); process.exit(0); }
  const k = await admin.createKey({ userId: String(user.id), orgId, agent: 'claude-code', name });
  const key = k.key;
  if (!/^wos_[A-Za-z0-9_-]{8,}$/.test(key || '')) die('The key came back in an unexpected shape; nothing written to settings.');
  const f = path.join(os.homedir(), '.claude', 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') die(`${f} is not valid JSON; fix it first.`); }
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  s.env = { ...(s.env || {}), WORK_OS_KEY: key };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
  console.log(`key created (${key.slice(0, 7)}…, shown in Access keys as "${name}") and written to ${f} as WORK_OS_KEY`);
} finally {
  await client.close();
}
