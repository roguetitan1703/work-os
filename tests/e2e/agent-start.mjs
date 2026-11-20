// POST /api/agent/start (app/api/agent/start/route.ts, lib/agent-sessions.ts): the Work OS hook signs in with its PC's
// worker device key and gets the start brief plus a session token for one session and one project; after a compaction
// the token gets the same session's brief again. Covers: a good device key (brief, token, session id that is not the
// token, presence row), the token again (same session, no new token), a token for another project (403), a project with
// no folder linked to it on that PC (404, the same answer as no project at all; an unlinked folder with its remote and a
// linked folder reported missing do not count), another organization's project (404), revoked
// computer (401 for its key and its tokens), a replaced key (old key and old tokens 401, new key works), a device whose
// owner is no longer a member (401), every other credential (wos_ keys, X-API-Key, a session cookie, junk: 401), bad
// bodies (400, 413), GET (405), the hourly limits (429 for a computer's new sessions and for one token's briefs), and the
// token nowhere in the brief or the database. Seed profile: none.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { B, EMAIL, MCP, ME, PW, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

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
  const gone = (await must(MCP, 'add_project', { name: 'Agent Gone', code: [{ remote: 'acme/agent-gone' }] })).project.id;
  await must(MCP, 'save_state', { project: 'Agent One', ops: [{ op: 'add_next', text: 'Agent brief line' }] });
  // Another organization's project, with a folder of the same remote on the owner's PC1.
  const X = await makeUser({ email: 'agent-x@example.test', name: 'Xena', orgName: 'Agent X Org' });
  const xKey = await mkKey({ agent: 'claude', userId: X.userId, orgId: X.orgId, name: 'x chat' });
  await must(xKey, 'add_project', { name: 'X Secret', code: [{ remote: 'acme/x-secret' }] });

  const pc1 = await deviceOf(A, 'agent-pc-1');
  const pc2 = await deviceOf(A, 'agent-pc-2');
  await rawDb.collection('workerFolders').insertMany([
    folder(pc1, A, 'fold1', 'acme/agent-one', one),
    folder(pc1, A, 'foldx', 'acme/x-secret', null),
    folder(pc1, A, 'foldb', 'acme/agent-bare', null), // the remote matches, but nobody linked it: the worker reports remotes itself
    { ...folder(pc1, A, 'foldg', 'acme/agent-gone', gone), missing: true }, // linked, but the worker no longer finds it
    folder(pc2, A, 'fold2', 'acme/agent-two', two),
  ]);
  const FOLDER_OF = { 'acme/agent-one': 'fold1', 'acme/x-secret': 'foldx', 'acme/agent-bare': 'foldb', 'acme/agent-gone': 'foldg', 'acme/agent-two': 'fold2' }; // the hook sends the worker folder ids (H13); the remote is information
  const at = (remote, extra = {}) => ({ folders: [FOLDER_OF[remote]].filter(Boolean), remote: `https://github.com/${remote}.git`, branch: 'main', path: `C:/code/${remote.split('/')[1]}`, machine: 'agent-pc', label: 'Claude Code', ...extra });

  // ---- a good device key ----
  const r1 = await post(pc1.key, at('acme/agent-one'));
  check('device key: 200 with the brief and a session token', r1.status === 200 && r1.json?.brief?.project?.id === one && /^wst_[A-Za-z0-9_-]{43}$/.test(r1.json?.token ?? ''), `${r1.status} ${r1.text.slice(0, 200)}`);
  const T1 = r1.json?.token ?? '';
  const sid = r1.json?.brief?.session;
  check('the brief is the start_work brief (State line, Orders, open tasks)', /Agent brief line/.test(JSON.stringify(r1.json?.brief)) && 'orders' in (r1.json?.brief ?? {}) && 'openTasks' in (r1.json?.brief ?? {}));
  check('the session id is not the token and the token is not in the brief', !!sid && sid !== T1 && !JSON.stringify(r1.json?.brief).includes(T1) && !JSON.stringify(r1.json?.brief).includes(T1.slice(4)));
  check('the device key is not in the answer', !r1.text.includes(pc1.key));
  // H5: a handover left with end_work is carried in the brief of a fresh session, once.
  const ho = await must(MCP, 'end_work', { project: 'Agent One', state: [{ op: 'add_later', text: 'agent-start later line' }], friction: 'none', handover: { step: 'agent-start handover step', title: 'Handover: agent-start' } });
  const rH = await post(pc1.key, at('acme/agent-one'));
  check('H5: the /api/agent/start brief carries the handover (id, from, markdown)', rH.status === 200 && rH.json?.brief?.handover?.some(h => h.id === ho.handover.id && h.markdown.includes('agent-start handover step')), `${rH.status} ${rH.text.slice(0, 300)}`);
  const rH2 = await post(pc1.key, at('acme/agent-one'));
  check('H5: a second fresh session is not shown the handover again', rH2.status === 200 && !rH2.json?.brief?.handover, `${rH2.status} ${rH2.text.slice(0, 200)}`);
  check('no-store on the answer', /no-store/.test(r1.headers.get('cache-control') ?? ''));
  check('the session is present on the project', !!(await rawDb.collection('presence').findOne({ session: sid, projectId: one })));
  // Lanes step 6: the folder's key (never its path) is on the row; a second live session in the same folder is told, a different folder is not.
  const rowS = await rawDb.collection('presence').findOne({ session: sid, projectId: one });
  const keyOf = (p) => crypto.createHmac('sha256', process.env.BETTER_AUTH_SECRET).update(`wos-folder.v1\n${pc1.id}\n${p.toLowerCase()}`).digest('hex');
  check('Lanes 6: the presence row carries the HMAC of device + path and the path is not stored', rowS?.folderKey === keyOf('c:/code/agent-one') && !JSON.stringify(rowS).includes('code/agent-one'), String(rowS?.folderKey));
  check('Lanes 6: the first session in a folder has no sameFolder; the next one in the same folder does (label, state, text)', !('sameFolder' in (r1.json?.brief ?? {})) && rH2.json?.brief?.sameFolder?.label === rowS?.label && ['on', 'working', 'idle', 'waiting'].includes(rH2.json?.brief?.sameFolder?.state), JSON.stringify(rH2.json?.brief?.sameFolder));
  const rOther = await post(pc1.key, at('acme/agent-one', { path: 'C:/other/checkout' }));
  check('Lanes 6: a session in another folder has no sameFolder', rOther.status === 200 && !('sameFolder' in (rOther.json?.brief ?? {})), JSON.stringify(rOther.json?.brief?.sameFolder));
  const rBack = await post(pc1.key, at('acme/agent-one', { path: 'c:' + String.fromCharCode(92) + 'CODE/agent-one/' }));
  check('Lanes 6: the same folder spelled another way (case, slashes, trailing slash) is the same folder', rBack.status === 200 && !!rBack.json?.brief?.sameFolder, JSON.stringify(rBack.json?.brief?.sameFolder));
  const row = await rawDb.collection('agentSessions').findOne({ _id: sid });
  check('agentSessions row: hash only, one project, about 24 h', !!row && row.projectId === one && row.deviceId === pc1.id && /^[0-9a-f]{64}$/.test(row.hash) && Math.abs(row.expiresAt - row.createdAt - 24 * 3600e3) < 5000);
  check('agentSessions row: the hash of the key it was made with', row?.keyHash === (await rawDb.collection('devices').findOne({ _id: pc1.id }))?.hash);

  // Where fills itself (H4): head, dirty and worktrees in the start body are kept per machine without a State version bump,
  // and the X-Work-OS-Hook header marks the hook protocol of the session (none = 1, the old hook).
  check('a start with no X-Work-OS-Hook header marks the session hook 1 (the old hook)', (await rawDb.collection('presence').findOne({ session: sid }))?.hook === 1);
  const vWhere = (await rawDb.collection('states').findOne({ _id: one })).version;
  const rw = await post(T1, { ...at('acme/agent-one'), machine: 'where-pc', head: 'a1b2c3d', dirty: true, worktrees: ['C:/code/agent-one [main]', 'C:/code/agent-one-b [builder-b]'] }, { headers: { 'x-work-os-hook': '2' } });
  const sdoc = await rawDb.collection('states').findOne({ _id: one });
  const wp = sdoc.where?.['where-pc'];
  check('head, dirty and worktrees in the start body fill Where for the machine, and the State version does not change', rw.status === 200 && wp?.head === 'a1b2c3d' && wp?.dirty === true && wp?.branch === 'main' && wp?.worktrees?.length === 2 && sdoc.version === vWhere && !sdoc.log.some(x => x.op === 'set_where'), JSON.stringify([rw.status, wp, sdoc.version, vWhere]));
  check('the X-Work-OS-Hook: 2 header marks the session hook 2', (await rawDb.collection('presence').findOne({ session: sid }))?.hook === 2);
  check('a header that is not a version (x) is ignored, like no header: hook 1', (await post(T1, {}, { headers: { 'x-work-os-hook': 'x' } })).status === 200 && (await rawDb.collection('presence').findOne({ session: sid }))?.hook === 1);
  check('more than 20 worktrees: 400', (await post(T1, { worktrees: Array.from({ length: 21 }, (_, i) => `w${i}`) })).status === 400);
  // The Claude account label: shown in list_sessions; an email-like one is dropped and the start still succeeds.
  const rAcct = await post(T1, { account: 'tools' });
  const ls1 = await mcpH(MCP, 'list_sessions', {});
  check('a start with account "tools" shows account tools in list_sessions', rAcct.status === 200 && (ls1.json?.sessions ?? []).find(x => x.session === sid)?.account === 'tools', rAcct.status + ' ' + JSON.stringify((ls1.json?.sessions ?? []).find(x => x.session === sid)));
  const rMail = await post(T1, { account: 'a@b.c' });
  check('an account that looks like an email is dropped and the start succeeds', rMail.status === 200 && (await rawDb.collection('presence').findOne({ session: sid }))?.account !== 'a@b.c' && !JSON.stringify(await rawDb.collection('presence').find({}).toArray()).includes('a@b.c'));
  const rLong = await post(T1, { account: 'x'.repeat(41) });
  check('an account over 40 characters is dropped and the start succeeds', rLong.status === 200 && !JSON.stringify(await rawDb.collection('presence').find({}).toArray()).includes('x'.repeat(41)));
  check('a head over 80 characters: 400', (await post(T1, { head: 'h'.repeat(81) })).status === 400);
  check('dirty must be a boolean: 400', (await post(T1, { dirty: 'yes' })).status === 400);
  // H6: Claude Code's own session id and what began the session (the row's state), and the device as machine.
  const CC = '3f2b8c1e-5d4a-4e7b-9c6d-1a2b3c4d5e6f';
  check('a ccSession that is not a UUID: 400', (await post(T1, { ccSession: 'not-a-uuid' })).status === 400 && (await post(T1, { ccSession: 'a'.repeat(32) })).status === 400);
  check('a source that is not one of the four: 400', (await post(T1, { source: 'other' })).status === 400);
  check('a ccSession and a startup source: accepted, the row is on, ccSession kept, machine is the device (not the hostname the body names)', (await post(T1, { ccSession: CC, source: 'startup', machine: 'some-hostname' })).status === 200 && await (async () => {
    const pr = await rawDb.collection('presence').findOne({ session: sid });
    return pr?.activity?.state === 'on' && pr.ccSession === CC && pr.machine === pc1.id && pr.machineName === 'agent-pc-1' && !JSON.stringify(pr).includes('some-hostname');
  })());
  check('a compaction start puts the row to working', (await post(T1, { ccSession: CC, source: 'compact' })).status === 200 && (await rawDb.collection('presence').findOne({ session: sid }))?.activity?.state === 'working');
  check('a start with neither field leaves the activity as it was', (await post(T1, {})).status === 200 && (await rawDb.collection('presence').findOne({ session: sid }))?.activity?.state === 'working');

  // The hook's session id, passed as `session` on an MCP call with a wos_ key of the same owner, is the same session (H3).
  const kSame = await mkKey({ agent: 'claude-code', name: 'agent-start same owner' });
  const toHook = await must(MCP, 'send_message', { project: 'Agent One', kind: 'fyi', body: 'to the hook session', to: sid });
  const viaKey = await mcpH(kSame, 'list_tasks', { project: 'Agent One' }, { 'X-Work-OS-Session': sid });
  check('the brief session id on an MCP call finds the same presence row (one row) and forYou names the message', (await rawDb.collection('presence').countDocuments({ session: sid, projectId: one })) === 1 && viaKey.json?.forYou?.some(l => /1 \w+ from me on project/.test(l)), JSON.stringify(viaKey.json?.forYou));
  check('…and the message is addressed to that session by its key', (await rawDb.collection('messages').findOne({ _id: toHook.id }))?.toSids?.[0] === `${A.userId}:${sid}`);

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
  check('an unlinked folder with the project\'s remote on this PC: 404 (the remote alone never counts)', r5.status === 404 && r5.text === r4none.text, `${r5.status} ${r5.text.slice(0, 160)}`);
  const r5g = await post(pc1.key, at('acme/agent-gone'));
  check('a linked folder the worker reports missing: 404', r5g.status === 404, r5g.status);
  const r6 = await post(pc1.key, at('acme/x-secret'));
  check("another organization's project (even with a folder of its remote here): 404, no name", r6.status === 404 && !/X Secret/.test(r6.text), `${r6.status} ${r6.text.slice(0, 160)}`);
  await rawDb.collection('workerFolders').insertMany([folder(pc1, A, 'h13link', 'acme/agent-one', one), folder(pc1, A, 'h13free', 'acme/agent-bare', null)]);
  // H13: with `folders` (the worker folder ids that contain the session's folder) the folder decides; the answer for an unfiled folder says so.
  const rF1 = await post(pc1.key, { ...at('acme/agent-one'), folders: ['h13free', 'h13link'] });
  check('H13: folders [unlinked, linked]: the linked folder decides (200, the project of f1)', rF1.status === 200 && rF1.json?.brief?.project?.id === one, `${rF1.status} ${rF1.text.slice(0, 160)}`);
  const rF2 = await post(pc1.key, { ...at('acme/agent-one'), folders: ['h13free'] });
  check('H13: only an unlinked folder, with the remote of a linked project: 404 unfiled (the remote never decides)', rF2.status === 404 && rF2.json?.unfiled === true && !rF2.json?.quiet && rF2.json?.error === r4none.json?.error, `${rF2.status} ${rF2.text.slice(0, 200)}`);
  check('H13: every 404 of the route says unfiled', [r4, r4none, r5, r5g, r6].every(r => r.json?.unfiled === true));
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
  await rawDb.collection('workerFolders').insertOne(folder(pc3, A, 'fold1', 'acme/agent-one', one));
  const T3 = (await post(pc3.key, at('acme/agent-one'))).json?.token ?? '';
  await rawDb.collection('devices').updateOne({ _id: pc3.id }, { $set: { revokedAt: new Date() } });
  check('revoked in the database only: the token is refused too', !!T3 && (await post(T3, at('acme/agent-one'))).status === 401);
  // a token whose row survived a key replace (made in a race with it): its key hash is no longer the computer's
  const pc5 = await deviceOf(A, 'agent-pc-5');
  await rawDb.collection('workerFolders').insertOne(folder(pc5, A, 'fold1', 'acme/agent-one', one));
  const T5 = (await post(pc5.key, at('acme/agent-one'))).json?.token ?? '';
  check('a token of the current key works', !!T5 && (await post(T5, {})).status === 200);
  await rawDb.collection('devices').updateOne({ _id: pc5.id }, { $set: { hash: 'f'.repeat(64) } });
  check('the computer has another key now (row kept): the token is refused', (await post(T5, {})).status === 401);

  // ---- an owner who is no longer a member ----
  const M = await makeUser({ email: 'agent-m@example.test', name: 'Moe', orgId: A.orgId, role: 'member' });
  const pcM = await deviceOf(M, 'moe-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pcM, M, 'fold1', 'acme/agent-one', one));
  await rawDb.collection('member').deleteOne({ userId: idIn(M.userId), organizationId: idIn(A.orgId) });
  const rM = await post(pcM.key, at('acme/agent-one'));
  check('a device whose owner left the organization: 401', rM.status === 401, `${rM.status} ${rM.text.slice(0, 120)}`);

  // ---- H15: a dispatched session is marked whatever started it (this PC's own worker session row says so) ----
  const dCreated = (await must(MCP, 'add_task', { title: 'H15 dispatched task', project: 'Agent One' })).created;
  const dTask = { ref: dCreated.ref, id: (await rawDb.collection('tasks').findOne({ ref: dCreated.ref }))._id };
  const pcP = await deviceOf(A, 'agent-pc-p');
  await rawDb.collection('workerFolders').insertOne(folder(pcP, A, 'fold1', 'acme/agent-one', one));
  const DCC = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const wsRow = (deviceId, ownerId, extra = {}) => ({ _id: DCC, orgId: A.orgId, ownerId, deviceId, folderId: 'fold1', projectId: one, state: 'running', startedAt: new Date(), updatedAt: new Date(), dispatched: true, taskId: dTask.id, ...extra });
  await rawDb.collection('workerSessions').insertOne(wsRow(pcP.id, A.userId));
  const pcD = await deviceOf(A, 'agent-pc-d');
  await rawDb.collection('workerFolders').insertOne(folder(pcD, A, 'fold1', 'acme/agent-one', one));
  const rD = await post(pcP.key, { ...at('acme/agent-one'), ccSession: DCC, source: 'startup' });
  const sD = rD.json?.brief?.session;
  check('H15: this PC own dispatched session row: the answer carries dispatched = the task ref', rD.status === 200 && rD.json?.dispatched === dTask.ref, `${rD.status} ${rD.text.slice(0, 200)}`);
  const pD = await rawDb.collection('presence').findOne({ session: sD });
  check('H15: its presence row carries dispatched and the label is forced to "<Project> · worker · #ref" (the hook label ignored)', pD?.dispatched?.ref === dTask.ref && pD.dispatched.taskId === dTask.id && pD.label === `Agent One · worker · #${dTask.ref}`, JSON.stringify([pD?.dispatched, pD?.label]));
  check('H15: its agentSessions row carries dispatched', (await rawDb.collection('agentSessions').findOne({ _id: sD }))?.dispatched?.ref === dTask.ref);
  const rDc = await post(rD.json?.token ?? '', { ...at('acme/agent-one'), ccSession: DCC, source: 'compact' });
  check('H15: a compaction start with the token answers dispatched again and the label stays', rDc.status === 200 && rDc.json?.dispatched === dTask.ref && !('token' in (rDc.json ?? {})) && (await rawDb.collection('presence').findOne({ session: sD }))?.label === `Agent One · worker · #${dTask.ref}`);
  const rDx = await post(pcD.key, { ...at('acme/agent-one'), ccSession: DCC, source: 'startup' });
  check('H15: the same session id from another computer of the same owner is not marked', rDx.status === 200 && !('dispatched' in (rDx.json ?? {})) && !(await rawDb.collection('presence').findOne({ session: rDx.json?.brief?.session }))?.dispatched);
  await rawDb.collection('workerSessions').updateOne({ _id: DCC }, { $set: { ownerId: X.userId } });
  const rDo = await post(pcP.key, { ...at('acme/agent-one'), ccSession: DCC, source: 'startup' });
  check('H15: a session row of another owner does not mark', rDo.status === 200 && !('dispatched' in (rDo.json ?? {})));
  await rawDb.collection('workerSessions').updateOne({ _id: DCC }, { $set: { ownerId: A.userId, dispatched: false } });
  const rDn = await post(pcP.key, { ...at('acme/agent-one'), ccSession: DCC, source: 'startup' });
  check('H15: a session row that is not dispatched does not mark', rDn.status === 200 && !('dispatched' in (rDn.json ?? {})));
  const rDu = await post(pcP.key, at('acme/agent-one'));
  check('H15: a start with no ccSession is never marked and keeps its own label', rDu.status === 200 && !('dispatched' in (rDu.json ?? {})) && (await rawDb.collection('presence').findOne({ session: rDu.json?.brief?.session }))?.label === 'Agent One · Claude Code');
  await rawDb.collection('workerSessions').deleteOne({ _id: DCC });

  // ---- hourly limits ----
  const pc4 = await deviceOf(A, 'agent-pc-4');
  await rawDb.collection('workerFolders').insertOne(folder(pc4, A, 'fold1', 'acme/agent-one', one));
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
  const toks = [T1, T2, T3, T4, T5].filter(Boolean);
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
