// Flow H15 (plan note 09b6210df3): the dispatcher on the Harness. Part 1 (step 1): the server marks a dispatched session whatever
// started it (the PC's own worker session row, the label forced, the mark on the presence row), and a resume job for it carries the
// task ref. Later parts (claim cap under concurrent polls, presence supervision) are added by their steps. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { B, EMAIL, ME, MCP, PW, check, finish, mkDevice, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
function actionOf(name, file) {
  for (const [id, e] of Object.entries(MANIFEST)) {
    const ws = e.exportedName ? [e] : Object.values(e.workers);
    if (!ws.some(w => w.exportedName === name && file.test(w.filename))) continue;
    const page = Object.keys(e.workers).find(x => !x.includes('[')) ?? Object.keys(e.workers)[0];
    return { id, url: '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).join('/') };
  }
  return null;
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function act(cookie, name, file, ...args) {
  const a = actionOf(name, file);
  if (!a) return { ok: false, text: `${name} not in the build` };
  const r = await fetch(B + a.url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return { ok: /"ok":true/.test(text), text };
}
const post = async (cred, body = {}) => {
  const r = await fetch(B + '/api/agent/start', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const folderRow = (dev, fid, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote: 'acme/h15-one', projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });

try {
  const proj = (await must(MCP, 'add_project', { name: 'H15 One', code: [{ remote: 'acme/h15-one' }] })).project.id;
  const created = (await must(MCP, 'add_task', { title: 'H15 task', project: 'H15 One' })).created;
  const task = { ref: created.ref, id: (await rawDb.collection('tasks').findOne({ ref: created.ref }))._id };
  const pc = await mkDevice('h15-pc');
  await rawDb.collection('workerFolders').insertOne(folderRow(pc, 'f1aa', proj));
  const at = (extra = {}) => ({ remote: 'https://github.com/acme/h15-one.git', branch: 'main', path: 'C:/code/h15-one', machine: 'h15-pc', label: 'Claude Code', folders: ['f1aa'], ...extra });

  // ---- 1: a worker session row for this PC marks the start, whatever started the session ----
  const cc = randomUUID();
  await rawDb.collection('workerSessions').insertOne({ _id: cc, orgId: ME.orgId, ownerId: ME.userId, deviceId: pc.id, folderId: 'f1aa', projectId: proj, state: 'running', startedAt: new Date(), updatedAt: new Date(), dispatched: true, taskId: task.id });
  const r1 = await post(pc.key, at({ ccSession: cc, source: 'resume' }));
  check('1: a resumed session of a dispatched row (no environment variable involved): dispatched = the task ref', r1.status === 200 && r1.json?.dispatched === task.ref, `${r1.status} ${r1.text.slice(0, 200)}`);
  const pr = await rawDb.collection('presence').findOne({ session: r1.json?.brief?.session });
  check('1: presence label forced to "H15 One · worker · #ref", the row carries dispatched', pr?.label === `H15 One · worker · #${task.ref}` && pr.dispatched?.ref === task.ref, JSON.stringify([pr?.label, pr?.dispatched]));
  const plain = await post(pc.key, at({ ccSession: randomUUID(), source: 'startup' }));
  check('1: another session on the same PC (no dispatched row) is not marked', plain.status === 200 && !('dispatched' in (plain.json ?? {})));

  // ---- 1: Resume of a dispatched session: the job carries the task ref; of an ordinary one it does not ----
  const cookie = await signIn(EMAIL);
  const ord = randomUUID();
  await rawDb.collection('workerSessions').insertOne({ _id: ord, orgId: ME.orgId, ownerId: ME.userId, deviceId: pc.id, folderId: 'f1aa', projectId: proj, state: 'dead', startedAt: new Date(), updatedAt: new Date() });
  await rawDb.collection('workerSessions').updateOne({ _id: cc }, { $set: { state: 'dead' } });
  await rawDb.collection('workerJobs').deleteMany({});
  const a1 = await act(cookie, 'resumeSessionAction', /launcher-actions\.ts$/, proj, cc);
  const a2 = await act(cookie, 'resumeSessionAction', /launcher-actions\.ts$/, proj, ord);
  const j1 = await rawDb.collection('workerJobs').findOne({ sessionId: cc, kind: 'resume' });
  const j2 = await rawDb.collection('workerJobs').findOne({ sessionId: ord, kind: 'resume' });
  check('1: resuming a dispatched session: the job carries the task ref', a1.ok && j1?.dispatched === task.ref, JSON.stringify([a1.text.slice(0, 120), j1]));
  check('1: resuming an ordinary session: no dispatched in the job', a2.ok && !!j2 && !('dispatched' in j2), JSON.stringify([a2.text.slice(0, 120), j2]));

  // ---- 2: the shell path: the real hook process (node worker/hook.mjs pre-tool) for a dispatched and an ordinary run ----
  const hook = path.join(ROOT, 'worker', 'hook.mjs');
  const runHook = (cmd, env = {}) => spawnSync(process.execPath, [hook, 'pre-tool'], { input: JSON.stringify({ session_id: 'h15-shell', tool_name: 'Bash', tool_input: { command: cmd }, cwd: ROOT }), encoding: 'utf8', timeout: 8000, env: { ...process.env, WORK_OS_KEY: '', WORK_OS_URL: '', WORK_OS_WORKER_DIR: path.join(ROOT, 'tmp-no-such-dir'), ...env } }).stdout || '';
  const curl = 'curl -s -H "Authorization: Bearer $WORK_OS_KEY" https://work.delpat.in/api/mcp';
  check('2: a dispatched run (WORK_OS_DISPATCHED) that curls /api/mcp with the key is refused, the reason names the Work OS tools', /"permissionDecision":"deny"/.test(runHook(curl, { WORK_OS_DISPATCHED: '301' })) && /Use the Work OS tools of this session/.test(runHook(curl, { WORK_OS_DISPATCHED: '301' })));
  check('2: the same command from the person own session is not refused', runHook(curl) === '');
  check('2: a dispatched run ordinary shell command passes', runHook('git status', { WORK_OS_DISPATCHED: '301' }) === '');
} catch (e) {
  check('flow-h15 suite (error)', false, e?.stack || String(e));
}
await finish();
