// POST /api/agent/state (app/api/agent/state/route.ts, lib/agent-auth.ts): the Work OS hook's State route. A session token
// (wst_, from /api/agent/start) answers the copy of its own project; an Edit of one WORK-STATE.md line is applied to the
// State; Where is written without a version bump. Covers: only a wst_ token opens it (no credential, a device key, a wos_
// key, a chat key, X-API-Key, a cookie, a made-up token, the session id: 401), 413, 400 for extra fields and bad bodies, 405,
// a token's own project only, the copy being the get_state copy:true text, an edit applied (version up, line changed, forwarded
// as Claude Code), refusals (several lines, no match, two matches, number or task mark changed, Decisions, header), an edit
// that removes a Next line with a ref (the task closes), Where (no version change), an unlinked folder, a revoked computer and
// a member who left (401), the hourly limit (429), and the token nowhere in the database. Seed profile: none.
import { ObjectId } from 'mongodb';
import { B, MCP, ME, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const idIn = id => ({ $in: [new ObjectId(id), String(id)] });
const call = async (url, cred, body = {}, { headers = {}, raw, method = 'POST' } = {}) => {
  const r = await fetch(B + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};
const start = (cred, body) => call('/api/agent/start', cred, body);
const st = (cred, body, o) => call('/api/agent/state', cred, body, o);
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
async function deviceOf(who, name) {
  const dev = await mkDevice(name);
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: who.userId, orgId: who.orgId } });
  return dev;
}
const at = remote => ({ remote: `https://github.com/${remote}.git`, branch: 'main', path: `C:/code/${remote.split('/')[1]}`, machine: 'state-pc', label: 'Claude Code' });
const stateDoc = async id => rawDb.collection('states').findOne({ _id: id });

try {
  const one = (await must(MCP, 'add_project', { name: 'State One', code: [{ remote: 'acme/state-one' }] })).project.id;
  const two = (await must(MCP, 'add_project', { name: 'State Two', code: [{ remote: 'acme/state-two' }] })).project.id;
  const task = (await must(MCP, 'add_task', { title: 'Linked to a Next line', project: 'State One' })).created;
  await must(MCP, 'save_state', {
    project: 'State One',
    ops: [
      { op: 'add_next', text: 'Write the route tests' },
      { op: 'add_next', text: 'Review the billing page' },
      { op: 'add_next', text: 'Review the settings page' },
      { op: 'add_next', text: 'Finish the linked task', ref: task.ref },
      { op: 'add_later', text: 'Try the new chart lib' },
      { op: 'add_decision', text: 'Secret pricing decision' },
    ],
  });
  await must(MCP, 'save_state', { project: 'State Two', ops: [{ op: 'add_next', text: 'Two only line' }] });

  const pc = await deviceOf(ME, 'state-pc-1');
  await rawDb.collection('workerFolders').insertMany([folder(pc, ME, 'f1', 'acme/state-one', one), folder(pc, ME, 'f2', 'acme/state-two', two)]);
  const s1 = await start(pc.key, at('acme/state-one'));
  const T1 = s1.json?.token ?? '';
  const sid = s1.json?.brief?.session;
  check('setup: a session token for State One', /^wst_/.test(T1), `${s1.status} ${s1.text.slice(0, 200)}`);
  const s2 = await start(pc.key, at('acme/state-two'));
  const T2 = s2.json?.token ?? '';

  // ---- the answer: the copy of the token's project ----
  const a0 = await st(T1, {});
  const cp = await must(await mkKey({ agent: 'claude-code', name: 'state copy reader' }), 'get_state', { project: 'State One', copy: true });
  check('an empty body: 200 with project, version and the copy', a0.status === 200 && a0.json?.project === one && a0.json?.version === cp.version && typeof a0.json?.markdown === 'string' && !('applied' in a0.json), `${a0.status} ${a0.text.slice(0, 200)}`);
  check('the copy is the same text get_state copy:true gives', a0.json?.markdown === cp.markdown, a0.json?.markdown);
  check('no Decisions and no Where in the copy (repo not known private)', !a0.json?.markdown.includes('Secret pricing') && !a0.json?.markdown.includes('## Where'), a0.json?.markdown);
  check('no-store on the answer', /no-store/.test(a0.headers.get('cache-control') ?? ''));
  const a2 = await st(T2, {});
  check('another project’s token gets only its own project', a2.status === 200 && a2.json?.project === two && /Two only line/.test(a2.json?.markdown) && !/Write the route tests/.test(a2.json?.markdown) && !/Two only line/.test(a0.text), a2.text.slice(0, 200));

  // ---- Where: no version bump ----
  const v0 = (await stateDoc(one)).version;
  const w = await st(T1, { where: { branch: 'builder-b', head: 'abc1234', dirty: true, worktrees: ['D:/wos-b [builder-b]'] } });
  const dw = await stateDoc(one);
  check('where is written (branch, head, dirty, worktrees) and the version does not change', w.status === 200 && dw.version === v0 && w.json.version === v0 && Object.values(dw.where ?? {}).some(x => x.head === 'abc1234' && x.dirty === true && x.branch === 'builder-b' && x.worktrees?.[0] === 'D:/wos-b [builder-b]'), JSON.stringify(dw.where));

  // ---- an edit is applied ----
  const e1 = await st(T1, { edit: { old: 'Write the route tests', new: 'Write the route and hook tests' } }, { headers: { 'x-work-os-hook': '2' } });
  const d1 = await stateDoc(one);
  check('an edit: 200, applied with the new version, the line changed in the State, the copy shows it', e1.status === 200 && e1.json?.applied?.version === v0 + 1 && d1.version === v0 + 1 && d1.next[0].text === 'Write the route and hook tests' && /Write the route and hook tests/.test(e1.json.markdown), e1.text.slice(0, 300));
  check('the log says it came through code, not the app', d1.log.some(x => x.op === 'edit_line' && x.via === 'code'), JSON.stringify(d1.log.slice(-2)));
  const e1b = await st(T1, { edit: { old: '2. Review the billing page', new: '2. Review the billing screen' } });
  check('an edit that includes the number prefix of the line (the file text) is applied', e1b.status === 200 && (await stateDoc(one)).next[1].text === 'Review the billing screen', e1b.text.slice(0, 300));
  const e1c = await st(T1, { edit: { old: 'Review the settings page', new: 'Review the settings page\r\n' } });
  check('a trailing newline (Edit tool) is trimmed', e1c.status === 200, e1c.text.slice(0, 200));

  // ---- refusals ----
  const v2 = (await stateDoc(one)).version;
  const refuse = async (label, edit, re) => {
    const r = await st(T1, { edit });
    check(`edit refused: ${label}`, r.status === 400 && (!re || re.test(r.json?.error ?? '')) && (await stateDoc(one)).version === v2, `${r.status} ${r.text.slice(0, 220)}`);
  };
  await refuse('several lines', { old: 'Review the billing screen\n2. Review the settings page', new: 'x' }, /one line/i);
  await refuse('no match', { old: 'text that is nowhere', new: 'x' }, /No Now, Next or Later line/);
  await refuse('two lines match', { old: 'Review the', new: 'Check the' }, /2 lines/);
  await refuse('the number changed', { old: '3. Review', new: '1. Review' }, /Change only the words/);
  await refuse('the task mark changed', { old: `Finish the linked task (#${task.ref})`, new: 'Finish the linked task' }, /Change only the words/);
  await refuse('a Decisions line', { old: 'Secret pricing decision', new: 'x' }, /No Now, Next or Later line/);
  await refuse('the header', { old: 'Copy of the Work OS state', new: 'x' }, /No Now, Next or Later line/);

  // ---- removing a Next line with a ref finishes its task ----
  const e2 = await st(T1, { edit: { old: 'Finish the linked task', new: '' } });
  const tdoc = await rawDb.collection('tasks').findOne({ ref: task.ref });
  check('an edit that empties a Next line with a task removes it and finishes the task (or sends it for review)', e2.status === 200 && !(await stateDoc(one)).next.some(l => l.text.includes('linked task')) && (tdoc.status === 'Done' || (e2.json?.applied?.sentForReview ?? []).includes(task.ref)), JSON.stringify([e2.json?.applied, tdoc.status]));

  // ---- bad credentials ----
  const wos = await mkKey({ agent: 'claude-code', name: 'cc' });
  const refusedAll = [
    ['no credential', await st('', {})],
    ['a device key', await st(pc.key, {})],
    ['a Claude Code key', await st(wos, {})],
    ['a Claude chat key', await st(MCP, {})],
    ['a made-up token', await st('wst_' + 'a'.repeat(43), {})],
    ['the session id as a token', await st(sid, {})],
    ['the token in X-API-Key', await st('', {}, { headers: { 'x-api-key': T1 } })],
    ['the token in a cookie', await st('', {}, { headers: { cookie: `token=${T1}` } })],
    ['Basic auth', await st('', {}, { headers: { authorization: `Basic ${Buffer.from('x:' + T1).toString('base64')}` } })],
  ];
  for (const [label, r] of refusedAll) check(`${label}: 401, no cookie, no state`, r.status === 401 && !r.headers.get('set-cookie') && !/markdown|Copy of/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
  check('GET: 405', (await call('/api/agent/state', T1, {}, { method: 'GET' })).status === 405);
  check('a lookalike path is guarded by the proxy: 401', (await call('/api/agent/statex', T1, {})).status === 401);
  check('a token does not open the MCP endpoint', (await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${T1}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status === 401);

  // ---- bad bodies ----
  check('an unknown field: 400', (await st(T1, { apiKey: 'x' })).status === 400);
  check('an unknown field inside edit: 400', (await st(T1, { edit: { old: 'a', new: 'b', all: true } })).status === 400);
  check('a project field is not taken (a token is for its own project)', (await st(T1, { project: two })).status === 400);
  check('not JSON: 400', (await st(T1, null, { raw: '{nope' })).status === 400);
  check('a body over 16 KB: 413', (await st(T1, { edit: { old: 'x'.repeat(17000), new: 'y' } })).status === 413);

  // ---- an unlinked folder, a revoked computer, a member who left ----
  const pc2 = await deviceOf(ME, 'state-pc-2');
  await rawDb.collection('workerFolders').insertOne(folder(pc2, ME, 'g1', 'acme/state-one', one));
  const T3 = (await start(pc2.key, at('acme/state-one'))).json?.token ?? '';
  check('a second computer’s token works', !!T3 && (await st(T3, {})).status === 200);
  await rawDb.collection('workerFolders').updateOne({ _id: `${pc2.id}:g1` }, { $set: { projectId: null, linkedAt: null } });
  const unl = await st(T3, {});
  check('a folder unlinked since the session began: 404, no copy', unl.status === 404 && !/Copy of/.test(unl.text), `${unl.status} ${unl.text.slice(0, 120)}`);
  await rawDb.collection('devices').updateOne({ _id: pc2.id }, { $set: { revokedAt: new Date() } });
  check('a revoked computer’s token: 401', (await st(T3, {})).status === 401);
  const M = await makeUser({ email: 'state-m@example.test', name: 'Moe', orgId: ME.orgId, role: 'member' });
  const pcM = await deviceOf(M, 'state-moe-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pcM, M, 'm1', 'acme/state-one', one));
  const TM = (await start(pcM.key, at('acme/state-one'))).json?.token ?? '';
  check('a member’s token works while they are a member', !!TM && (await st(TM, {})).status === 200);
  await rawDb.collection('member').deleteOne({ userId: idIn(M.userId), organizationId: idIn(ME.orgId) });
  check('a token whose owner left the organization: 401', (await st(TM, {})).status === 401);

  // ---- hourly limit: 240 State calls per token ----
  const pc4 = await deviceOf(ME, 'state-pc-4');
  await rawDb.collection('workerFolders').insertOne(folder(pc4, ME, 'h1', 'acme/state-one', one));
  const T4 = (await start(pc4.key, at('acme/state-one'))).json?.token ?? '';
  let ok = 0;
  for (let i = 0; i < 245 && T4; i++) if ((await st(T4, {})).status === 200) ok++;
  const over = await st(T4, {});
  check('one token: 240 State calls an hour, then 429 with Retry-After', ok === 240 && over.status === 429 && !!over.headers.get('retry-after'), `${ok} then ${over.status}`);

  // ---- the token is nowhere in the database ----
  const found = [];
  for (const { name } of await rawDb.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const all = JSON.stringify(await rawDb.collection(name).find({}).toArray());
    for (const t of [T1, T2, T3, T4, TM].filter(Boolean)) if (all.includes(t) || all.includes(t.slice(4))) found.push(name);
  }
  check('no session token is stored anywhere (only its hash)', found.length === 0, found.join(', '));
} catch (e) {
  check('agent-state suite (error)', false, e?.stack || String(e));
}
await finish();
