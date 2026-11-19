// Flow H15 (plan note 09b6210df3): the dispatcher on the Harness. Part 1 (step 1): the server marks a dispatched session whatever
// started it (the PC's own worker session row, the label forced, the mark on the presence row), and a resume job for it carries the
// task ref. Later parts (claim cap under concurrent polls, presence supervision) are added by their steps. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { B, EMAIL, ME, MCP, PW, check, cron, finish, makeUser, mkDevice, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

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

  // ---- 4: presence supervision: put back once, then a Need; the person's stop or take back never revives ----
  const events = (token, event) => fetch(B + '/api/agent/event', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ event }) }).then(r => r.status);
  const mkTask = async (title) => {
    const c2 = (await must(MCP, 'add_task', { title, project: 'H15 One' })).created;
    return { ref: c2.ref, id: (await rawDb.collection('tasks').findOne({ ref: c2.ref }))._id };
  };
  const markOf = (sid, extra = {}) => ({ state: 'running', markedAt: new Date(Date.now() - 3600e3), markedBy: 'user', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(Date.now() - 30 * 60e3), deviceId: pc.id, sessionId: sid, prevStatus: 'Not Started', ...extra });
  const runTask = async (t, sid, extra = {}) => {
    await rawDb.collection('tasks').updateOne({ _id: t.id }, { $set: { status: 'In Progress', claude: markOf(sid, extra) } });
    await rawDb.collection('workerSessions').updateOne({ _id: sid }, { $set: { orgId: ME.orgId, ownerId: ME.userId, deviceId: pc.id, folderId: 'f1aa', projectId: proj, state: 'running', startedAt: new Date(Date.now() - 30 * 60e3), updatedAt: new Date(), dispatched: true, taskId: t.id } }, { upsert: true });
  };
  const live = async (t, sid) => { // a real start (presence row with this Claude Code session id), as the dispatched session's hook makes it
    await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { lastSeenAt: new Date() } });
    const r = await post(pc.key, at({ ccSession: sid, source: 'startup' }));
    return r.json?.token ?? '';
  };
  const task4 = (t) => rawDb.collection('tasks').findOne({ _id: t.id });
  const needsOf = (t) => rawDb.collection('needs').find({ taskId: t.id, dispatch: { $exists: true } }).toArray();
  const stoppedAlerts = (t) => rawDb.collection('alertQueue').countDocuments({ taskId: t.id, kind: 'claude_stopped' });
  const quiet = async (n = 1) => { for (let i = 0; i < n; i++) await cron(); };

  // 4a: the session ended itself (its SessionEnd reached Work OS) with the task not done: put back once, no alert, a comment
  const tA = await mkTask('H15 ends itself');
  const sA = randomUUID();
  await runTask(tA, sA);
  const tokA = await live(tA, sA);
  check('4a: the live session is not touched by the reconciler (presence on, computer just seen)', (await quiet(), (await task4(tA)).claude.state === 'running'));
  check('4a: SessionEnd reaches Work OS (event end)', (await events(tokA, 'end')) === 200);
  await quiet();
  const aa1 = await task4(tA);
  check('4a: a session that ended itself, task not done: put back in the queue once (revived 1, no session, status restored)', aa1.claude.state === 'queued' && aa1.claude.revived === 1 && !aa1.claude.sessionId && aa1.status === 'Not Started', JSON.stringify([aa1.claude, aa1.status]));
  check('4a: a comment says it restarted, no claude_stopped alert, no Need', (await rawDb.collection('activity').countDocuments({ taskId: tA.id, type: 'comment', note: /started again once/ })) === 1 && (await stoppedAlerts(tA)) === 0 && (await needsOf(tA)).length === 0);
  // 4b: the second time: stopped, the alert stays, and the giver gets the Need
  const sB = randomUUID();
  await runTask(tA, sB, { revived: 1 });
  const tokB = await live(tA, sB);
  await events(tokB, 'end');
  await quiet(2);
  const b1 = await task4(tA);
  const nb = await needsOf(tA);
  check('4b: ended a second time: stopped, not put back again', b1.claude.state === 'stopped' && b1.claude.revived === 1, JSON.stringify(b1.claude));
  check('4b: the claude_stopped alert is queued once', (await stoppedAlerts(tA)) === 1, String(await stoppedAlerts(tA)));
  check('4b: one open app-only decide Need to the giver: again / takeback, the task, no task title in the ask', nb.length === 1 && nb[0].status === 'open' && nb[0].appOnly === true && nb[0].kind === 'decide' && nb[0].to === ME.userId && nb[0].options.map(o => o.id).join() === 'again,takeback' && nb[0].dispatch?.taskId === tA.id && nb[0].taskRef === tA.ref && !/H15 ends itself/.test(nb[0].ask), JSON.stringify(nb[0]));
  // 4c: a quiet computer beside a session that still reports is not a dead session; both silent is
  const tC = await mkTask('H15 quiet worker');
  const sC = randomUUID();
  await runTask(tC, sC);
  await live(tC, sC);
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { lastSeenAt: new Date(Date.now() - 25 * 60e3) } });
  await quiet();
  check('4c: the worker is quiet 25 minutes but the session still reports through its hooks: left running', (await task4(tC)).claude.state === 'running');
  await rawDb.collection('presence').updateMany({ ccSession: sC }, { $set: { lastSeen: new Date(Date.now() - 25 * 60e3) } });
  await quiet();
  const c1 = await task4(tC);
  check('4c: computer and session both silent 25 minutes: put back once', c1.claude.state === 'queued' && c1.claude.revived === 1, JSON.stringify(c1.claude));
  // 4d: the person's stop never revives
  const tD = await mkTask('H15 stopped by the person');
  const sD2 = randomUUID();
  await runTask(tD, sD2);
  await rawDb.collection('workerSessions').updateOne({ _id: sD2 }, { $set: { state: 'stopped' } });
  await quiet();
  const d1 = await task4(tD);
  check('4d: a session the person stopped ends the claim as stopped: no restart, no Need', d1.claude.state === 'stopped' && !d1.claude.revived && (await needsOf(tD)).length === 0, JSON.stringify(d1.claude));
  // 4e: take back (with Stop) never revives
  const tE = await mkTask('H15 taken back');
  const sE = randomUUID();
  await runTask(tE, sE);
  const cookie4 = await signIn(EMAIL);
  const tb = await act(cookie4, 'takeBackFromClaudeAction', /dispatcher-actions\.ts$/, `#${tE.ref}`, true);
  await rawDb.collection('workerSessions').updateOne({ _id: sE }, { $set: { state: 'dead' } });
  await quiet(2);
  const e1 = await task4(tE);
  check('4e: taken back with Stop: stopped, the dead session afterwards does not restart it, no Need', tb.ok && e1.claude.state === 'stopped' && !e1.claude.revived && (await needsOf(tE)).length === 0, JSON.stringify([tb.text.slice(0, 100), e1.claude]));
  // 4f: a task that is Done or Blocked is never put back
  const tF = await mkTask('H15 done meanwhile');
  const sF = randomUUID();
  await runTask(tF, sF);
  await rawDb.collection('tasks').updateOne({ _id: tF.id }, { $set: { status: 'Done' } });
  await rawDb.collection('workerSessions').updateOne({ _id: sF }, { $set: { state: 'dead' } });
  await quiet();
  check('4f: task Done and the session gone: finished, not restarted', (await task4(tF)).claude.state === 'finished');
  // 4g: the Need answers: only the giver; "again" gives it to Claude again as a fresh run, "takeback" clears it
  const stranger = await makeUser({ email: 'h15-stranger@example.test', name: 'Stranger', orgId: ME.orgId, role: 'member' });
  const cookieS = await signIn('h15-stranger@example.test');
  const wrong = await act(cookieS, 'answerNeedAction', /needs\/actions\.ts$/, nb[0]._id, 'again');
  check('4g: someone else cannot answer the Need (not addressed to them)', !wrong.ok && (await needsOf(tA))[0].status === 'open', wrong.text.slice(0, 160));
  void stranger;
  const ans = await act(cookie4, 'answerNeedAction', /needs\/actions\.ts$/, nb[0]._id, 'again');
  const g1 = await task4(tA);
  const gn = (await needsOf(tA))[0];
  check('4g: "Give to Claude again": answered by the giver, the task is queued as a fresh mark (not revived)', ans.ok && gn.status === 'answered' && g1.claude.state === 'queued' && !g1.claude.revived && gn.dispatch.result === 'given to Claude again', JSON.stringify([ans.text.slice(0, 120), g1.claude, gn.dispatch]));
  const again = await act(cookie4, 'answerNeedAction', /needs\/actions\.ts$/, nb[0]._id, 'takeback');
  check('4g: a Need answers once', !again.ok);
  // a new Need for another task, answered "Take back"
  const sG = randomUUID();
  await runTask(tD, sG, { revived: 1 });
  await rawDb.collection('workerSessions').updateOne({ _id: sG }, { $set: { state: 'dead' } });
  await quiet();
  const nd = await needsOf(tD);
  const tk = await act(cookie4, 'answerNeedAction', /needs\/actions\.ts$/, nd[0]._id, 'takeback');
  check('4g: "Take back": the claim is cleared', tk.ok && (await task4(tD)).claude === null && (await needsOf(tD))[0].dispatch.result === 'taken back from Claude', JSON.stringify([tk.text.slice(0, 120), (await task4(tD)).claude]));

  // 4h (H15 review): a dispatched run calling start_work itself keeps the forced label and the mark
  const tH = await mkTask('H15 label kept');
  const sH = randomUUID();
  await runTask(tH, sH);
  const rH = await post(pc.key, at({ ccSession: sH, source: 'startup' }));
  const sidH = rH.json?.brief?.session;
  const sw = await mcpH(MCP, 'start_work', { project: 'H15 One', label: 'my own label' }, { 'X-Work-OS-Session': sidH });
  const pH = await rawDb.collection('presence').findOne({ session: sidH });
  check('4h: start_work from the dispatched session itself cannot rename it: the forced label and the mark stay', !!sw && pH?.label === `H15 One · worker · #${tH.ref}` && pH.dispatched?.ref === tH.ref, JSON.stringify([pH?.label, pH?.dispatched]));
  // 4i: a stop request is the person's stop: a session that ends (presence off) before the worker reports stopped is not started again
  const tI = await mkTask('H15 stop pending');
  const sI = randomUUID();
  await runTask(tI, sI);
  const tokI = await live(tI, sI);
  await rawDb.collection('workerJobs').insertOne({ _id: 'j_stop_' + sI, orgId: ME.orgId, ownerId: ME.userId, deviceId: pc.id, kind: 'stop', sessionId: sI, createdAt: new Date(), takenAt: null, doneAt: null });
  await events(tokI, 'end');
  await quiet();
  const i1 = await task4(tI);
  check('4i: Stop pressed, presence ended first: stopped, no restart, no Need', i1.claude.state === 'stopped' && !i1.claude.revived && (await needsOf(tI)).length === 0, JSON.stringify(i1.claude));
  // 4j: another person's presence row with the same Claude Code session id says nothing about this claim
  const tJ = await mkTask('H15 foreign presence');
  const sJ = randomUUID();
  await runTask(tJ, sJ);
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { lastSeenAt: new Date() } });
  await rawDb.collection('presence').insertOne({ _id: 'pres-foreign-' + sJ, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', projectId: proj, userId: 'someone-else', key: 'x', session: 'x' + sJ, label: 'x', machine: '', ai: 'x', agent: 'claude-code', lastSeen: new Date(), forYouCursor: new Date(), writesSinceSave: 0, ccSession: sJ, endedAt: new Date(), activity: { state: 'off', at: new Date() } });
  await quiet();
  check('4j: a presence row of someone else with this session id (ended) does not end the claim', (await task4(tJ)).claude.state === 'running');
} catch (e) {
  check('flow-h15 suite (error)', false, e?.stack || String(e));
}
await finish();
