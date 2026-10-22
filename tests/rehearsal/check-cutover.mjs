// Cut-over rehearsal, part 3 (docs/hosting.md "Rehearsal"): after scripts/cutover.sh --apply on the database that
// seed-legacy.mjs filled, checks that the migrated owner can get in and finds the old work, through the NEW app:
//   - /api/live answers "ok"
//   - "Forgot password?" mails a link to OWNER_EMAIL; the link sets a password; the owner signs in
//   - Tasks, Today, Projects, Notes, Review › Trash and Timetable show the old data
//   - /api/admin/health answers the owner (an operator) with the old counts
//   - a Claude chat key of the owner sees the old tasks over MCP
//   - in the database: nothing left without an organization, old settings ids gone, old computers revoked,
//     no leftover temporary key, reviews and routine logs moved
//
//   BASE=http://localhost:3283 MAIL_CAPTURE_DIR=… OWNER_EMAIL=… BETTER_AUTH_SECRET=… MONGODB_URI=… MONGODB_DB=…
//     node tests/rehearsal/check-cutover.mjs
// Throwaway databases on localhost only. Prints PASS/FAIL lines and RESULT pass=… fail=….
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { authAdmin } from '../../scripts/lib/auth-admin.mjs';

const B = process.env.BASE;
const MAIL = process.env.MAIL_CAPTURE_DIR;
const OWNER = process.env.OWNER_EMAIL?.toLowerCase();
const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB;
if (!B || !MAIL || !OWNER || !URI || !DB) throw new Error('set BASE, MAIL_CAPTURE_DIR, OWNER_EMAIL, MONGODB_URI, MONGODB_DB');
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) throw new Error('throwaway databases on localhost only');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` :: ${String(detail).slice(0, 200)}`}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const take = res => {
  for (const sc of res.headers.getSetCookie()) {
    const [nv] = sc.split(';');
    const i = nv.indexOf('=');
    const k = nv.slice(0, i).trim();
    const v = nv.slice(i + 1).trim();
    if (!v || /max-age=0/i.test(sc)) delete cookies[k];
    else cookies[k] = v;
  }
};
async function auth(p, body) {
  const r = await fetch(B + '/api/auth' + p, { method: 'POST', headers: { origin: B, 'content-type': 'application/json', cookie: cookieHeader() }, body: JSON.stringify(body), redirect: 'manual' });
  take(r);
  return { status: r.status, text: await r.text() };
}
async function page(p) {
  const r = await fetch(B + p, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
  take(r);
  return { status: r.status, html: await r.text() };
}

const mc = new MongoClient(URI);
await mc.connect();
const db = mc.db(DB);
try {
  const live = await fetch(B + '/api/live');
  check('/api/live -> 200 "ok"', live.status === 200 && (await live.text()) === 'ok', live.status);

  // ── The owner gets in: reset by email, then sign in ──
  const since = Date.now() - 1000;
  const rq = await auth('/request-password-reset', { email: OWNER, redirectTo: '/login/reset' });
  check('owner: password reset requested', rq.status === 200, rq.status);
  let link = '';
  for (let i = 0; i < 40 && !link; i++) {
    const files = fs.existsSync(MAIL) ? fs.readdirSync(MAIL).filter(f => f.endsWith('.json')) : [];
    const m = files.map(f => JSON.parse(fs.readFileSync(path.join(MAIL, f), 'utf8'))).find(x => x.to === OWNER && Date.parse(x.at) >= since && /reset-password\//.test(x.text));
    link = m?.text.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
    if (!link) await wait(250);
  }
  check('owner: reset link mailed to the owner', !!link);
  const PW = 'rehearsal-owner-password-1';
  const rs = await auth('/reset-password', { newPassword: PW, token: link });
  check('owner: new password set from the link', rs.status === 200, `${rs.status} ${rs.text.slice(0, 80)}`);
  const si = await auth('/sign-in/email', { email: OWNER, password: PW });
  check('owner: signs in', si.status === 200 && !!Object.keys(cookies).find(k => k.endsWith('session_token')), `${si.status} ${si.text.slice(0, 80)}`);

  // ── The old work, on the pages ──
  const want = {
    '/tasks': ['Send invoice to Grant Leads', 'Fix webhook retries', 'Landing page copy', 'Draft follow-up email'],
    '/today': ['Pricing decision', 'Fix webhook retries'],
    '/projects': ['Grant Leads', 'AKAR', 'Delpat Site', 'Fiverr'],
    '/notes': ['AKAR scope', 'Site plan'],
    '/review?view=trash': ['Duplicate idea'],
    '/review?view=done': ['Header logo vector'],
  };
  for (const [p, titles] of Object.entries(want)) {
    const r = await page(p);
    const missing = titles.filter(t => !r.html.includes(t));
    check(`page ${p}: 200 with the old ${titles.length} item(s)`, r.status === 200 && !missing.length, `${r.status} missing: ${missing.join(', ')}`);
  }
  const tt = await page('/timetable');
  check('page /timetable: the old week is the owner\'s (a block from the legacy timetable shows)', tt.status === 200 && tt.html.includes('Morning Setup'), tt.status);

  // ── Operator report ──
  const h = await fetch(B + '/api/admin/health', { headers: { cookie: cookieHeader() } });
  const hj = await h.json().catch(() => ({}));
  const tasksInDb = await db.collection('tasks').countDocuments();
  check('/api/admin/health: the owner is the operator, counts match the database', h.status === 200 && hj.counts?.tasks === tasksInDb, `${h.status} ${JSON.stringify(hj.counts ?? hj)}`);
  const anon = await fetch(B + '/api/admin/health');
  check('/api/admin/health without a session -> 401', anon.status === 401, anon.status);

  // ── MCP with a key of the owner (made here, deleted after) ──
  const user = await db.collection('user').findOne({ email: OWNER });
  const org = await db.collection('organization').findOne({});
  const admin = authAdmin({ db, client: mc, secret: process.env.BETTER_AUTH_SECRET, baseURL: B });
  const { key, id } = await admin.createKey({ userId: String(user._id), orgId: String(org._id), agent: 'claude', name: 'rehearsal check' });
  try {
    const r = await fetch(B + '/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }),
    });
    const raw = await r.text();
    const line = raw.split('\n').find(l => l.startsWith('data: '));
    const text = JSON.parse(line ? line.slice(6) : raw).result?.content?.[0]?.text ?? '';
    check('MCP list_tasks (owner\'s key): the old open tasks', r.status === 200 && text.includes('Send invoice to Grant Leads') && text.includes('Fix webhook retries'), `${r.status} ${text.slice(0, 120)}`);
  } finally {
    await db.collection('apikey').deleteOne({ _id: id.length === 24 ? new (await import('mongodb')).ObjectId(id) : id });
  }

  // ── The database after the cut-over ──
  const noOrg = {};
  for (const c of ['projects', 'tasks', 'activity', 'notes', 'claudeItems', 'trash', 'reviews', 'ritualLogs', 'notifications', 'pushSubs', 'alertLog']) {
    const n = await db.collection(c).countDocuments({ orgId: { $exists: false } });
    if (n) noOrg[c] = n;
  }
  check('every document has an organization', !Object.keys(noOrg).length, JSON.stringify(noOrg));
  // Folders of an old computer (no owner, revoked by migrate-auth) are left as they are, by design.
  const unownedDevices = (await db.collection('devices').find({ ownerId: { $exists: false } }).project({ _id: 1 }).toArray()).map(d => d._id);
  const strayFolders = await db.collection('workerFolders').countDocuments({ orgId: { $exists: false }, deviceId: { $nin: unownedDevices } });
  check('folders without an organization belong only to old (revoked) computers', strayFolders === 0, strayFolders);
  const oldIds = await db.collection('settings').countDocuments({ _id: { $in: ['notify', 'dispatcher', 'discord', 'alerts', 'status'] } });
  check('old settings ids moved to <area>:<id>', oldIds === 0, oldIds);
  check('old computers revoked', (await db.collection('devices').countDocuments({ ownerId: { $exists: false }, revokedAt: null })) === 0);
  check('no temporary key left (Discord registration, this check)', (await db.collection('apikey').countDocuments()) === 0, await db.collection('apikey').countDocuments());
  check('weekly reviews hold answers', (await db.collection('reviews').countDocuments({ answers: { $exists: false } })) === 0);
  check('routine logs: bidsPlaced → count', (await db.collection('ritualLogs').countDocuments({ bidsPlaced: { $exists: true } })) === 0);
  const fix = await db.collection('tasks').findOne({ title: 'Fix webhook retries' });
  check('a task given to Claude records who gave it', fix?.claude?.markedByUserId === String(user._id), JSON.stringify(fix?.claude ?? null));
  const ci = await db.collection('claudeItems').findOne({ waitingText: { $exists: true, $ne: '' } });
  check('Claude item waiting on Om → waitingText + waitingOn', !!ci && ci.waitingOn === String(user._id), JSON.stringify(ci ? { waitingOn: ci.waitingOn } : null));
  const prof = await db.collection('settings').findOne({ _id: `profile:${user._id}` });
  check('owner profile: timezone and Discord account from the old variables', !!prof?.timezone && !!prof?.discordId, JSON.stringify(prof ? Object.keys(prof) : null));
} catch (e) {
  check('rehearsal check (error)', false, e?.stack || String(e));
} finally {
  await mc.close();
}
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
