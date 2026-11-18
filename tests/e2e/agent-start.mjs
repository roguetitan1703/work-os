// POST /api/agent/start (app/api/agent/start/route.ts, lib/agent-sessions.ts): the Work OS hook signs in with its PC's
// worker device key and gets the start brief plus a session token for one session and one project; after a compaction
// the token gets the same session's brief again. Covers: a good device key (brief, token, session id that is not the
// token, presence row), the token again (same session, no new token), a token for another project (403), a project with
// no folder on that PC (404, the same answer as no project at all), another organization's project (404), revoked
// computer (401 for its key and its tokens), a replaced key (old key and old tokens 401, new key works), a device whose
// owner is no longer a member (401), every other credential (wos_ keys, X-API-Key, a session cookie, junk: 401), bad
// bodies (400, 413), GET (405), the hourly limits (429 for a computer's new sessions and for one token's briefs), and the
// token nowhere in the brief or the database. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { B, EMAIL, MCP, ME, PW, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const URL_ = B + '/api/agent/start';
const idIn = id => ({ $in: [new ObjectId(id), String(id)] });
const post = async (cred, body = {}, { headers = {}, raw } = {}) => {
  const r = await fetch(URL_, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: raw ?? JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: projectId ? new Date() : null, seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
async function deviceOf(who, name) {
  const dev = await mkDevice(name); // made for the owner; moved to `who`
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: who.userId, orgId: who.orgId } });
  return dev;
}

// Server actions, called the way the browser does (the build's manifest gives the export its id).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
function actionOf(name) {
  for (const [id, e] of Object.entries(MANIFEST)) {
    const ws = e.exportedName ? [e] : Object.values(e.workers);
    if (!ws.some(w => w.exportedName === name && /claude\/setup-actions\.ts$/.test(w.filename))) continue;
    const page = Object.keys(e.workers).find(x => !x.includes('[')) ?? Object.keys(e.workers)[0];
    return { id, url: '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).join('/') };
  }
  return null;
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function act(cookie, name, ...args) {
  const a = actionOf(name);
  if (!a) return { ok: false, text: `${name} not in the build` };
  const r = await fetch(B + a.url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return { ok: /"ok":true/.test(text), text, key: (/"key":"(wkr_[A-Za-z0-9_-]+)"/.exec(text) ?? [])[1] };
}

try {
  const A = ME;
  // The owner's projects: One (folder on PC1), Two (folder on PC2 only), Bare (no folder anywhere).
  const one = (await must(MCP, 'add_project', { name: 'Agent One', code: [{ remote: 'acme/agent-one' }] })).project.id;
  const two = (await must(MCP, 'add_project', { name: 'Agent Two', code: [{ remote: 'acme/agent-two' }] })).project.id;
  await must(MCP, 'add_project', { name: 'Agent Bare', code: [{ remote: 'acme/agent-bare' }] });
  await must(MCP, 'save_state', { project: 'Agent One', ops: [{ op: 'add_next', text: 'Agent brief line' }] });
  // Another organization's project, with a folder of the same remote on the owner's PC1.
  const X = await makeUser({ email: 'agent-x@example.test', name: 'Xena', orgName: 'Agent X Org' });
  const xKey = await mkKey({ agent: 'claude', userId: X.userId, orgId: X.orgId, name: 'x chat' });
  await must(xKey, 'add_project', { name: 'X Secret', code: [{ remote: 'acme/x-secret' }] });

  const pc1 = await deviceOf(A, 'agent-pc-1');
  const pc2 = await deviceOf(A, 'agent-pc-2');
  await rawDb.collection('workerFolders').insertMany([
    folder(pc1, A, 'f1', 'acme/agent-one', one),
    folder(pc1, A, 'fx', 'acme/x-secret', null),
    folder(pc2, A, 'f2', 'acme/agent-two', two),
  ]);
  const at = (remote, extra = {}) => ({ remote: `https://github.com/${remote}.git`, branch: 'main', path: `C:/code/${remote.split('/')[1]}`, machine: 'agent-pc', label: 'Claude Code', ...extra });

  // ---- a good device key ----
  const r1 = await post(pc1.key, at('acme/agent-one'));
  check('device key: 200 with the brief and a session token', r1.status === 200 && r1.json?.brief?.project?.id === one && /^wst_[A-Za-z0-9_-]{43}$/.test(r1.json?.token ?? ''), `${r1.status} ${r1.text.slice(0, 200)}`);
  const T1 = r1.json?.token ?? '';
  const sid = r1.json?.brief?.session;
  check('the brief is the start_work brief (State line, Orders, open tasks)', /Agent brief line/.test(JSON.stringify(r1.json?.brief)) && 'orders' in (r1.json?.brief ?? {}) && 'openTasks' in (r1.json?.brief ?? {}));
  check('the session id is not the token and the token is not in the brief', !!sid && sid !== T1 && !JSON.stringify(r1.json?.brief).includes(T1) && !JSON.stringify(r1.json?.brief).includes(T1.slice(4)));
  check('the device key is not in the answer', !r1.text.includes(pc1.key));
  check('no-store on the answer', /no-store/.test(r1.headers.get('cache-control') ?? ''));
  check('the session is present on the project', !!(await rawDb.collection('presence').findOne({ session: sid, projectId: one })));
  const row = await rawDb.collection('agentSessions').findOne({ _id: sid });
  check('agentSessions row: hash only, one project, about 24 h', !!row && row.projectId === one && row.deviceId === pc1.id && /^[0-9a-f]{64}$/.test(row.hash) && Math.abs(row.expiresAt - row.createdAt - 24 * 3600e3) < 5000);

  // ---- the token again (after a compaction) ----
  const r2 = await post(T1, at('acme/agent-one'));
  check('token: the same session brief again, no new token', r2.status === 200 && r2.json?.brief?.session === sid && !('token' in (r2.json ?? {})), `${r2.status} ${r2.text.slice(0, 160)}`);
  const r2b = await post(T1, {});
  check('token with no folder given: its own project', r2b.status === 200 && r2b.json?.brief?.project?.id === one, r2b.status);
  const r3 = await post(T1, at('acme/agent-two'));
  check('token for another project: 403', r3.status === 403 && !JSON.stringify(r3.json).includes('Agent Two'), `${r3.status} ${r3.text.slice(0, 160)}`);
  const r3b = await post(T1, at('acme/x-secret'));
  check("token at another organization's project: 403", r3b.status === 403, r3b.status);

  // ---- projects the device key may not open ----
  const r4 = await post(pc1.key, at('acme/agent-two'));
  const r4none = await post(pc1.key, at('acme/no-such-project'));
  check('a project with no folder on this PC: 404', r4.status === 404, `${r4.status} ${r4.text.slice(0, 160)}`);
  check('...the same answer as no project at all', r4.text === r4none.text && r4none.status === 404, `${r4.text} | ${r4none.text}`);
  const r5 = await post(pc1.key, at('acme/agent-bare'));
  check('a project with no folder anywhere: 404', r5.status === 404, r5.status);
  const r6 = await post(pc1.key, at('acme/x-secret'));
  check("another organization's project (even with a folder of its remote here): 404, no name", r6.status === 404 && !/X Secret/.test(r6.text), `${r6.status} ${r6.text.slice(0, 160)}`);
  const r7 = await post(pc2.key, at('acme/agent-two'));
  check('the PC that has the folder opens it', r7.status === 200 && r7.json?.brief?.project?.id === two, r7.status);
  const T2 = r7.json?.token ?? '';

  // ---- credentials that are not a device key or a token ----
  const wos = await mkKey({ agent: 'claude-code', name: 'cc' });
  const cookie = await signIn(EMAIL);
  const refusedAll = [
    ['no credential', await post('', at('acme/agent-one'))],
    ['a Claude Code key', await post(wos, at('acme/agent-one'))],
    ['a Claude chat key', await post(MCP, at('acme/agent-one'))],
    ['the device key in X-API-Key', await post('', at('acme/agent-one'), { headers: { 'x-api-key': pc1.key } })],
    ['a session cookie', await post('', at('acme/agent-one'), { headers: { cookie } })],
    ['a made-up device key', await post('wkr_' + 'a'.repeat(43), at('acme/agent-one'))],
    ['a made-up token', await post('wst_' + 'a'.repeat(43), at('acme/agent-one'))],
    ['the session id as a token', await post(sid, at('acme/agent-one'))],
    ['Basic auth', await post('', at('acme/agent-one'), { headers: { authorization: `Basic ${Buffer.from('x:' + pc1.key).toString('base64')}` } })],
  ];
  for (const [label, r] of refusedAll) check(`${label}: 401, no cookie`, r.status === 401 && !r.headers.get('set-cookie'), `${r.status} ${r.text.slice(0, 120)}`);
  const g = await fetch(URL_, { headers: { authorization: `Bearer ${pc1.key}` }, redirect: 'manual' });
  check('GET: 405, not a login redirect', g.status === 405, g.status);
  const look = await fetch(URL_ + 'x', { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${pc1.key}` }, body: '{}' });
  check('a lookalike path is still guarded by the proxy: 401', look.status === 401, look.status);

  // ---- bad bodies ----
  check('an unknown field: 400', (await post(pc1.key, { ...at('acme/agent-one'), apiKey: 'x' })).status === 400);
  check('not JSON: 400', (await post(pc1.key, null, { raw: '{nope' })).status === 400);
  check('a body over 8 KB: 413', (await post(pc1.key, { ...at('acme/agent-one'), path: 'x'.repeat(9000) })).status === 413);

  // ---- a replaced key ends the old key and its tokens ----
  const rep = await act(cookie, 'replaceDeviceKeyAction', pc1.id);
  check('replace the key of PC1 (server action)', rep.ok && /^wkr_/.test(rep.key ?? ''), rep.text.slice(0, 200));
  check('replaced: the old key is refused', (await post(pc1.key, at('acme/agent-one'))).status === 401);
  check('replaced: the old token is refused', (await post(T1, at('acme/agent-one'))).status === 401);
  check('replaced: its session rows are gone', (await rawDb.collection('agentSessions').countDocuments({ deviceId: pc1.id })) === 0);
  const rNew = rep.key ? await post(rep.key, at('acme/agent-one')) : { status: 0 };
  check('replaced: the new key works', rNew.status === 200, rNew.status);

  // ---- a revoked computer ----
  const rev = await act(cookie, 'revokeDeviceAction', pc2.id);
  check('revoke PC2 (server action)', rev.ok, rev.text.slice(0, 200));
  check('revoked: its key is refused', (await post(pc2.key, at('acme/agent-two'))).status === 401);
  check('revoked: its token is refused', (await post(T2, at('acme/agent-two'))).status === 401);
  // a token whose row survived (as if the delete failed) is still refused for a revoked computer
  const pc3 = await deviceOf(A, 'agent-pc-3');
  await rawDb.collection('workerFolders').insertOne(folder(pc3, A, 'f3', 'acme/agent-one', one));
  const T3 = (await post(pc3.key, at('acme/agent-one'))).json?.token ?? '';
  await rawDb.collection('devices').updateOne({ _id: pc3.id }, { $set: { revokedAt: new Date() } });
  check('revoked in the database only: the token is refused too', !!T3 && (await post(T3, at('acme/agent-one'))).status === 401);

  // ---- an owner who is no longer a member ----
  const M = await makeUser({ email: 'agent-m@example.test', name: 'Moe', orgId: A.orgId, role: 'member' });
  const pcM = await deviceOf(M, 'moe-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pcM, M, 'fm', 'acme/agent-one', one));
  await rawDb.collection('member').deleteOne({ userId: idIn(M.userId), organizationId: idIn(A.orgId) });
  const rM = await post(pcM.key, at('acme/agent-one'));
  check('a device whose owner left the organization: 401', rM.status === 401, `${rM.status} ${rM.text.slice(0, 120)}`);

  // ---- hourly limits ----
  const pc4 = await deviceOf(A, 'agent-pc-4');
  await rawDb.collection('workerFolders').insertOne(folder(pc4, A, 'f4', 'acme/agent-one', one));
  const T4 = (await post(pc4.key, at('acme/agent-one'))).json?.token ?? '';
  let briefs = 0;
  for (let i = 0; i < 25 && T4; i++) if ((await post(T4, {})).status === 200) briefs++;
  const over = await post(T4, {});
  check('one token: 20 briefs an hour, then 429', briefs === 20 && over.status === 429 && !!over.headers.get('retry-after'), `${briefs} then ${over.status}`);
  let made = 1;
  for (let i = 0; i < 35; i++) if ((await post(pc4.key, at('acme/no-such-project'))).status !== 429) made++; // misses count too: no probing past the limit
  const over2 = await post(pc4.key, at('acme/agent-one'));
  check('one computer: 30 new sessions (or misses) an hour, then 429', made === 30 && over2.status === 429, `${made} then ${over2.status}`);

  // ---- the token is nowhere in the database ----
  const toks = [T1, T2, T3, T4].filter(Boolean);
  let found = [];
  for (const { name } of await rawDb.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const docs = await rawDb.collection(name).find({}).toArray();
    const all = JSON.stringify(docs);
    for (const t of toks) if (all.includes(t) || all.includes(t.slice(4))) found.push(name);
  }
  check('no session token is stored anywhere (only its hash)', found.length === 0, found.join(', '));
} catch (e) {
  check('agent-start suite (error)', false, e?.stack || String(e));
}
await finish();
