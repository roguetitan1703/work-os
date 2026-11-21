// POST /api/agent/start (app/api/agent/start/route.ts, lib/agent-sessions.ts): the Work OS hook signs in with its PC's
// worker device key and gets the start brief plus a session token for one session and one project; after a compaction
// the token gets the same session's brief again. Covers: a good device key (brief, token, session id that is not the
// token, presence row), the token again (same session, no new token), a token for another project (403), a project with
// no folder linked to it on that PC (404, the same answer as no project at all; an unlinked folder with its remote and a
// linked folder reported missing do not count), another organization's project (404), revoked
// computer (401 for its key and its tokens), a replaced key (old key and old tokens 401, new key works), a device whose
// owner is no longer a member (401), every other credential (wos_ keys, X-API-Key, a session cookie, junk: 401), bad
// bodies (400, 413), GET (405), the hourly limits (429 for a computer's new sessions and for one token's briefs), and the
// token nowhere in the brief or the database. Also the session record (plan note db5bf91389, piece A): one session keeps one id
// across project moves, unfiled to filed, /clear and a second sign-in; tokens are keys (two valid at once); elsewhere; old hooks and a foreign
// remote; a merged old id is not revived; another computer ends the first one's rows. Seed profile: none.
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
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).concat('wos.sessions.filter=11').join('; '); // every session shows (lib.mjs setSessionFilter)
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
  const r3 = await post(T1, at('acme/agent-two'), { headers: { 'x-work-os-hook': '4' } });
  check('token at the folder of a project that is not on this PC: no 403 and no switch: it stays on its project, elsewhere (the project is not named)', r3.status === 200 && r3.json?.brief?.project?.id === one && r3.json?.elsewhere === true && !JSON.stringify(r3.json).includes('Agent Two'), `${r3.status} ${r3.text.slice(0, 160)}`);
  const r3b = await post(T1, at('acme/x-secret'), { headers: { 'x-work-os-hook': '4' } });
  check("token at another organization's folder: no switch either, and nothing of that organization in the answer", r3b.status === 200 && r3b.json?.brief?.project?.id === one && !/X Secret/.test(r3b.text), r3b.status);

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

  // ---- the session record (plan note db5bf91389, A): one Claude Code session keeps one id ----
  const H4 = { 'x-work-os-hook': '4' };
  const H3 = { 'x-work-os-hook': '3' };
  const uuid = () => crypto.randomUUID();
  const pcI = await deviceOf(A, 'agent-pc-i');
  const pcI2 = await deviceOf(A, 'agent-pc-i2');
  await rawDb.collection('workerFolders').insertMany([folder(pcI, A, 'ifold1', 'acme/agent-one', one), folder(pcI, A, 'ifold2', 'acme/agent-two', two), folder(pcI2, A, 'ifold1', 'acme/agent-one', one), folder(pcI, A, 'ipar', 'acme/parent', null)]);
  const ev4 = (tok, body) => fetch(B + '/api/agent/event', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const rowsOf = (sid_, extra = {}) => rawDb.collection('presence').find({ session: sid_, ...extra }).toArray();
  const openOf = async sid_ => (await rowsOf(sid_)).filter(r => !r.endedAt);
  const C1 = uuid();
  const PROC = { pid: 4242, procStart: '133000000000000001' };
  const i1 = await post(pcI.key, { folders: ['ifold1'], machine: 'ipc', head: 'aaa1111', branch: 'main', path: 'C:/code/agent-one', ccSession: C1, source: 'startup', proc: PROC }, { headers: H4 });
  const sI = i1.json?.brief?.session;
  const TI = i1.json?.token ?? '';
  const idRec = await rawDb.collection('agentIdentities').findOne({ _id: sI });
  check('record: a new session makes its record (id = the first token row id, the Claude Code session, the project, the proc)', i1.status === 200 && !!idRec && idRec.ccSessions.includes(C1) && idRec.projectId === one && idRec.deviceId === pcI.id && idRec.proc?.pid === 4242 && !!(await rawDb.collection('agentSessions').findOne({ _id: sI, sessionId: sI })), `${i1.status} ${JSON.stringify(idRec)}`);
  const rowI = (await rowsOf(sI, { projectId: one }))[0];
  // token for P + a folder no project owns: stays on P, elsewhere, nothing written for the folder
  const whereBefore = JSON.stringify((await rawDb.collection('states').findOne({ _id: one })).where?.ipc);
  const i2 = await post(TI, { folders: ['nothere'], machine: 'ipc', head: 'bbb2222', branch: 'other', path: 'C:/code/parent', ccSession: C1, source: 'resume', proc: PROC }, { headers: H4 });
  const rowI2 = (await rowsOf(sI, { projectId: one }))[0];
  check('elsewhere: a token for P with a folder no project owns: same id, P, elsewhere: true and the folder ids of P on this PC', i2.status === 200 && i2.json?.brief?.session === sI && i2.json?.brief?.project?.id === one && i2.json?.elsewhere === true && JSON.stringify(i2.json?.projectFolders) === JSON.stringify(['ifold1']) && !('token' in (i2.json ?? {})), `${i2.status} ${i2.text.slice(0, 220)}`);
  check('elsewhere: Where and the folder key are unchanged, and the brief has no sameFolder', JSON.stringify((await rawDb.collection('states').findOne({ _id: one })).where?.ipc) === whereBefore && rowI2?.folderKey === rowI?.folderKey && !('sameFolder' in (i2.json?.brief ?? {})));
  // the same with the device key and no token (a restart): the same session through its Claude Code session id
  const i2b = await post(pcI.key, { folders: ['nothere'], path: 'C:/code/parent', ccSession: C1, source: 'resume', proc: PROC }, { headers: H4 });
  check('elsewhere: a restart with the device key and no token is the same session (by its Claude Code session id), a new token, one open row', i2b.status === 200 && i2b.json?.brief?.session === sI && i2b.json?.elsewhere === true && /^wst_/.test(i2b.json?.token ?? '') && (await openOf(sI)).length === 1, `${i2b.status} ${i2b.json?.brief?.session} ${sI}`);
  check('tokens are keys: both tokens of the session still work (nothing was deleted or replaced)', (await ev4(TI, { event: 'tool' })).status === 200 && (await ev4(i2b.json?.token ?? '', { event: 'tool' })).status === 200 && (await rawDb.collection('agentSessions').countDocuments({ sessionId: sI })) === 2);
  // start_work with no machine (the agent's own call), then a hook start: the same id and one row
  const swr = await mcpH(kSame, 'start_work', { project: 'Agent One' }, { 'X-Work-OS-Session': sI });
  const i2c = await post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one', ccSession: C1, source: 'resume', proc: PROC }, { headers: H4 });
  check('start_work with no machine, then a hook start: the same id, one presence row', !swr.isError && i2c.json?.brief?.session === sI && (await rowsOf(sI, { projectId: one })).length === 1, `${swr.text.slice(0, 120)} ${i2c.json?.brief?.session}`);
  // an old hook (protocol 3) with a foreign remote is unfiled; with no remote or the project's own remote it stays filed
  const old1 = await post(TI, { folders: ['nothere'], remote: 'https://github.com/other/zzz.git', ccSession: C1 }, { headers: H3 });
  check('old hook: a foreign remote and no folder of the project: unfiled, the same id, no token (it has one), the P row ended and a none row opened', old1.status === 200 && old1.json?.unfiled === true && !('token' in (old1.json ?? {})) && !!(await rowsOf(sI, { projectId: one }))[0]?.endedAt && (await rowsOf(sI, { projectId: null })).length === 1 && (await rawDb.collection('agentIdentities').findOne({ _id: sI })).projectId === null, `${old1.status} ${old1.text.slice(0, 160)}`);
  const un1 = await post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one', ccSession: C1, source: 'startup', proc: PROC }, { headers: H4 });
  check('unfiled, then the folder is linked: the same id on the project, no 403, one open row, the none row ended', un1.status === 200 && un1.json?.brief?.session === sI && un1.json?.brief?.project?.id === one && (await openOf(sI)).length === 1 && !!(await rowsOf(sI, { projectId: null }))[0]?.endedAt, `${un1.status} ${un1.json?.brief?.session}`);
  const old2 = await post(TI, { folders: ['nothere'], remote: 'https://github.com/acme/agent-one.git', ccSession: C1 }, { headers: H3 });
  const old3 = await post(TI, { folders: ['nothere'], ccSession: C1 }, { headers: H3 });
  check('old hook: the project\'s own remote, or no remote: stays filed on its project', old2.status === 200 && old2.json?.brief?.project?.id === one && old3.status === 200 && old3.json?.brief?.project?.id === one, `${old2.status} ${old3.status}`);
  const old4 = await post(TI, { folders: ['nothere'], remote: 'https://github.com/other/zzz.git', ccSession: C1 }, { headers: { 'x-work-os-hook': '2' } });
  check('old hook (protocol 2): a foreign remote: the 404 as before, nothing changed', old4.status === 404 && old4.json?.unfiled === true && (await rawDb.collection('agentIdentities').findOne({ _id: sI })).projectId === one);
  // a session unfiled from the start gets its token, and the folder being linked later keeps the id
  const C2 = uuid();
  const u0 = await post(pcI.key, { folders: ['ipar'], path: 'C:/code/parent', ccSession: C2, source: 'startup', proc: { pid: 4343, procStart: '133000000000000002' } }, { headers: H3 });
  const sU = (await rawDb.collection('agentIdentities').findOne({ ccSessions: C2 }))?._id;
  check('unfiled start (hook 3): an unfiled answer with a token and a record with no project', u0.status === 200 && u0.json?.unfiled === true && /^wst_/.test(u0.json?.token ?? '') && !!sU && (await rawDb.collection('agentIdentities').findOne({ _id: sU })).projectId === null);
  await rawDb.collection('workerFolders').updateOne({ _id: `${pcI.id}:ipar` }, { $set: { projectId: one, linkedAt: new Date() } });
  const u1 = await post(u0.json?.token ?? '', { folders: ['ipar'], path: 'C:/code/parent', ccSession: C2, source: 'startup' }, { headers: H3 });
  check('unfiled, then its folder is linked (the unfiled token): the same id on the project, no 403, one open row', u1.status === 200 && u1.json?.brief?.session === sU && u1.json?.brief?.project?.id === one && (await openOf(sU)).length === 1 && (await rowsOf(sU, { projectId: null }))[0]?.endedAt, `${u1.status} ${u1.text.slice(0, 160)}`);
  await rawDb.collection('workerFolders').updateOne({ _id: `${pcI.id}:ipar` }, { $set: { projectId: null, linkedAt: null } });
  // the folder of Q: same id, on Q, the P row ended
  const q1 = await post(TI, { folders: ['ifold2'], path: 'C:/code/agent-two', ccSession: C1, source: 'startup' }, { headers: H4 });
  check('folder of project Q: the same id on Q (no 403), the P row ended, one open row, the record is on Q', q1.status === 200 && q1.json?.brief?.session === sI && q1.json?.brief?.project?.id === two && !('elsewhere' in (q1.json ?? {})) && !!(await rowsOf(sI, { projectId: one }))[0]?.endedAt && (await openOf(sI)).length === 1 && (await rawDb.collection('agentIdentities').findOne({ _id: sI })).projectId === two, `${q1.status} ${q1.text.slice(0, 160)}`);
  check('…and the token now answers for Q (an event goes to the Q row)', (await ev4(TI, { event: 'prompt' })).status === 200 && !!(await rowsOf(sI, { projectId: two }))[0]?.activity);
  // /clear: a new Claude Code session id in the same claude process (pid and start time) is the same session
  const C1b = uuid();
  const cl = await post(pcI.key, { folders: ['ifold2'], path: 'C:/code/agent-two', ccSession: C1b, source: 'clear', proc: PROC }, { headers: H4 });
  check('/clear with the same pid and start time: the same id, both Claude Code session ids on the record', cl.status === 200 && cl.json?.brief?.session === sI && (await rawDb.collection('agentIdentities').findOne({ _id: sI })).ccSessions.sort().join() === [C1, C1b].sort().join(), `${cl.status} ${cl.json?.brief?.session} vs ${sI}`);
  const clx = await post(pcI.key, { folders: ['ifold2'], path: 'C:/code/agent-two', ccSession: uuid(), source: 'clear', proc: { pid: 4242, procStart: '133000000000000999' } }, { headers: H4 });
  const clr = await post(pcI.key, { folders: ['ifold2'], path: 'C:/code/agent-two', ccSession: uuid(), source: 'resume', proc: PROC }, { headers: H4 });
  check('a clear with another start time, or a new Claude Code session id that is not a clear: a new session', clx.status === 200 && clx.json?.brief?.session !== sI && clr.status === 200 && clr.json?.brief?.session !== sI);
  // two starts at once for one Claude Code session: one record, both tokens work
  const C3 = uuid();
  const [c1, c2] = await Promise.all([1, 2].map(() => post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one', ccSession: C3, source: 'startup' }, { headers: H4 })));
  const sC = c1.json?.brief?.session;
  check('two concurrent starts of one Claude Code session: one record, both answer 200 with the same id', c1.status === 200 && c2.status === 200 && !!sC && c2.json?.brief?.session === sC && (await rawDb.collection('agentIdentities').countDocuments({ ccSessions: C3 })) === 1, `${c1.status} ${c2.status} ${c1.json?.brief?.session} ${c2.json?.brief?.session}`);
  check('…and both tokens post events', (await ev4(c1.json?.token ?? '', { event: 'prompt' })).status === 200 && (await ev4(c2.json?.token ?? '', { event: 'stop' })).status === 200);
  // a merged old id sent again does not bring its row back
  const C4 = uuid();
  const m1 = await post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one', ccSession: C4, source: 'startup' }, { headers: H4 });
  const sM = m1.json?.brief?.session;
  await rawDb.collection('presence').updateOne({ session: sM, projectId: one }, { $set: { endedAt: new Date(Date.now() - 60_000), movedTo: 'someone-else-key', lastSeen: new Date(Date.now() - 3600_000) }, $unset: { activity: '' } });
  const mBefore = await rawDb.collection('presence').findOne({ session: sM, projectId: one });
  const mev = await ev4(m1.json?.token ?? '', { event: 'prompt' });
  const mAfter = await rawDb.collection('presence').findOne({ session: sM, projectId: one });
  const mw = await fetch(B + '/api/agent/wait', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${m1.json?.token}` }, body: '{}' });
  const mAfter2 = await rawDb.collection('presence').findOne({ session: sM, projectId: one });
  check('a merged old id (ended, movedTo) sending an event or a wait: the row keeps its endedAt, its time and no new activity', mev.status === 200 && !!mAfter?.endedAt && !mAfter.activity && +mAfter.lastSeen === +mBefore.lastSeen && mw.status === 200 && +mAfter2.lastSeen === +mBefore.lastSeen, `${mev.status} ${mw.status} ${JSON.stringify(mAfter?.activity)}`);
  // another computer of the same person: the first one's rows for that Claude Code session end
  const C5 = uuid();
  const a1 = await post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one', ccSession: C5, source: 'startup' }, { headers: H4 });
  const a2 = await post(pcI2.key, { folders: ['ifold1'], path: 'D:/code/agent-one', ccSession: C5, source: 'resume' }, { headers: H4 });
  check('the same Claude Code session id on another computer: its own session id there, and the first computer\'s row ends', a2.status === 200 && a2.json?.brief?.session !== a1.json?.brief?.session && !!(await rowsOf(a1.json?.brief?.session))[0]?.endedAt && !(await rowsOf(a2.json?.brief?.session))[0]?.endedAt);
  check('the record of a legacy token (a row with no sessionId) is made on its first use, with its own id', await (async () => {
    const legacy = (await post(pcI.key, { folders: ['ifold1'], path: 'C:/code/agent-one' }, { headers: H4 })).json;
    const lid = legacy?.brief?.session;
    await rawDb.collection('agentIdentities').deleteOne({ _id: lid });
    await rawDb.collection('agentSessions').updateOne({ _id: lid }, { $unset: { sessionId: '' } });
    const r = await post(legacy?.token ?? '', {}, { headers: H4 });
    return r.status === 200 && r.json?.brief?.session === lid && !!(await rawDb.collection('agentIdentities').findOne({ _id: lid }));
  })());

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
