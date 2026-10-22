// Dispatcher backend: claim on worker poll, caps, MCP cannot set claude, outcomes, reconciler, alerts once. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { db, check, mkDevice, api, mcpRaw as mcp, cron, finish, ME } from './lib.mjs';

const status = (d, extra = {}, allowPrompts = true) => api(d.key, 'POST', '/api/worker/status', { worker: { version: '0.1.0', os: 'win32', allowPrompts }, jobs: [], sessions: [], ...extra });
const poll = d => api(d.key, 'GET', '/api/worker/jobs');
const task = ref => db.collection('tasks').findOne({ ref });
const now = Date.now();
const base = { description: 'SECRET-DESCRIPTION-TEXT', mode: null, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', createdAt: new Date(now - 864e5), updatedAt: new Date(now - 36e5), doneAt: null, doneOn: null, doneBy: null };
const mk = (ref, title, o = {}) => ({ ...base, _id: 'd' + ref, ref, title, ...o });
const mark = (n, o = {}) => ({ state: 'queued', markedAt: new Date(now - (100 - n) * 60_000), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, ...o });
const link = (dev, fid, projectId, o = {}) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: 'folder-' + fid, git: false, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, ...o });

// ── clean slate ──
for (const n of ['tasks', 'activity', 'alertLog', 'alertQueue', 'notifications', 'workerSessions', 'workerJobs', 'workerFolders', 'devices', 'settings', 'policyEvents']) await db.collection(n).deleteMany({});
const D1 = await mkDevice('PC-1'), D2 = await mkDevice('NoPrompts'), D3 = await mkDevice('PC-3');
await db.collection('workerFolders').insertMany([
  link(D1, 'f_aaaa1', 'p1'), link(D3, 'f_cccc1', 'p1'), link(D2, 'f_bbbb1', 'p2'),
  link(D1, 'f_aaaa9', 'p2', { missing: true }), // missing folder on D1 for p2 must not be used
]);
await db.collection('tasks').insertMany([
  mk(101, 'T101 first marked', { projectId: 'p1', claude: mark(1) }),
  mk(102, 'T102 second', { projectId: 'p1', claude: mark(2), status: 'In Progress' }),
  mk(103, 'T103 third', { projectId: 'p1', claude: mark(3) }),
  mk(104, 'T104 not marked', { projectId: 'p1' }),
  mk(105, 'T105 other project on no-prompt device', { projectId: 'p2', claude: mark(5) }),
  mk(106, 'T106 blocked, marked', { projectId: 'p1', status: 'Blocked', claude: mark(0) }),
]);
await db.collection('counters').updateOne({ _id: 'task' }, { $set: { seq: 200 } }, { upsert: true });

// ── gates ──
await status(D1); await status(D2, {}, false); await status(D3);
const dd = await db.collection('devices').findOne({ _id: D2.id });
check('worker status stores allowPrompts false', dd.worker?.allowPrompts === false, JSON.stringify(dd.worker));
check('worker status stores allowPrompts true', (await db.collection('devices').findOne({ _id: D1.id })).worker?.allowPrompts === true);

let r = await poll(D1);
check('dispatcher off (no settings doc): no jobs, nothing claimed', r.status === 200 && r.body.jobs.length === 0 && (await task(101)).claude.state === 'queued');
// The note every session reads first must be the person's own (dispatcher.ts ownNote).
await db.collection('notes').insertOne({ _id: 'n1', title: 'Rules', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: 'me', createdAt: new Date(), updatedBy: 'me', updatedAt: new Date(), deletedAt: null });
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: true, maxConcurrent: 2, boilerplateNoteId: 'n1' } }, { upsert: true });

r = await poll(D2);
check('allowPrompts:false device gets nothing', r.body.jobs.length === 0 && (await task(105)).claude.state === 'queued' && (await task(101)).claude.state === 'queued', JSON.stringify(r.body.jobs));
await status(D2, {}, true);
r = await poll(D2);
check('same device once it reports allowPrompts true: claims its own project task', r.body.jobs.length === 1 && (await task(105)).claude.state === 'running', JSON.stringify(r.body));
// put 105 back so it does not hold a slot
await db.collection('workerJobs').deleteMany({}); await db.collection('workerSessions').deleteMany({});
await db.collection('tasks').updateOne({ ref: 105 }, { $set: { claude: null, status: 'Not Started' } });
await status(D2, {}, false);

// ── concurrent polls: never the same task ──
const ps = await Promise.all([poll(D1), poll(D3), poll(D1), poll(D3), poll(D1), poll(D3)]);
const running = (await db.collection('tasks').find({ 'claude.state': 'running' }).toArray()).sort((a, b) => a.ref - b.ref);
const sess = await db.collection('workerSessions').find({ dispatched: true }).toArray();
const startJobs = await db.collection('workerJobs').find({ kind: 'start' }).toArray();
const r1 = running[0];
const rs = running.map(t => t.ref).sort();
check('6 concurrent polls never claim a task twice, stay within the cap, oldest first', running.length >= 1 && running.length <= 2 && rs[0] === 101 && new Set(running.map(t => t.claude.sessionId)).size === running.length, rs.join(','));
check('one dispatched session row and one start job per claimed task', sess.length === running.length && startJobs.length === running.length && sess.every(x => running.some(r => r.claude.sessionId === x._id && r._id === x.taskId)), `${sess.length}/${startJobs.length}`);
check('task 101 set In Progress, prevStatus recorded, device recorded', r1.ref === 101 && r1.status === 'In Progress' && r1.claude.prevStatus === 'Not Started' && !!r1.claude.deviceId);
const job = startJobs.find(j => j.sessionId === r1.claude.sessionId);
check('start job has no task text, only the fixed template', !/T101|SECRET-DESCRIPTION|first marked/.test(job.prompt) && job.prompt.includes('#101') && job.prompt.includes('n1') && job.prompt.length < 4000, job.prompt);
const gotJob = ps.flatMap(x => x.body.jobs).filter(j => j.kind === 'start');
check('the job reached a poll response', gotJob.length >= 1);
check('no inbox notice for the dispatcher status change', (await db.collection('notifications').countDocuments({ kind: 'claude_code_changes' })) === 0);
const act = await db.collection('activity').find({ taskId: 'd101' }).toArray();
check('history records the dispatcher start', act.some(a => /Dispatcher: started Claude/.test(a.note || '')), JSON.stringify(act.map(a => a.note)));

// ── cap 2 ──
const winnerDev = running[0].claude.deviceId;

const dev = winnerDev === D1.id ? D1 : D3;
await poll(dev); // claims 102 (oldest remaining)
const r2 = await db.collection('tasks').find({ 'claude.state': 'running' }).sort({ ref: 1 }).toArray();
check('102 claimed (In Progress task keeps prevStatus In Progress)', r2.length === 2 && r2[1].ref === 102 && r2[1].claude.prevStatus === 'In Progress', r2.map(t => t.ref).join(','));
await poll(D1); await poll(D3); await poll(D1);
check('cap 2 holds: 103 stays queued after more polls', (await db.collection('tasks').countDocuments({ 'claude.state': 'running' })) === 2 && (await task(103)).claude.state === 'queued');
check('blocked task never claimed, unmarked task untouched', (await task(106)).claude.state === 'queued' && !(await task(104)).claude);

// ── MCP / apply_changes cannot set or clear claude ──
let m = await mcp('update_task', { task: 104, claude: { state: 'queued', markedAt: new Date().toISOString(), markedBy: 'om' }, priority: 'P3', note: 'try' });
check('MCP update_task with a claude field leaves claude unset (priority applied)', !(await task(104)).claude && (await task(104)).priority === 'P3', m.text.slice(0, 200));
m = await mcp('apply_changes', { ops: [{ op: 'update_task', task: 104, claude: { state: 'queued', markedAt: new Date().toISOString() }, tags: ['x'] }, { op: 'update_task', task: 103, claude: null }, { op: 'create_task', title: 'created with claude', claude: { state: 'queued' } }] });
const created = await db.collection('tasks').findOne({ title: 'created with claude' });
check('MCP apply_changes cannot set claude on 104, clear it on 103, or create a marked task', !(await task(104)).claude && (await task(103)).claude?.state === 'queued' && (!created || !created.claude), m.text.slice(0, 300));
m = await mcp('update_task', { task: 102, claude: null, progress: 10, note: 'try clear' });
check('MCP update_task cannot clear a running claim', (await task(102)).claude.state === 'running', m.text.slice(0, 200));
m = await mcp('log_progress', { task: 102, progress: 20, note: 'working' });
check('MCP log_progress keeps running claim', (await task(102)).claude.state === 'running');

// ── Done frees the slot, alert once ──
m = await mcp('complete_task', { task: 101, note: 'all done' });
let t101 = await task(101);
check('Done by the session -> finished at once', t101.claude.state === 'finished' && !!t101.claude.endedAt, JSON.stringify(t101.claude) + m.text.slice(0, 100));
let q = await db.collection('alertQueue').find({ kind: 'claude_finished' }).toArray();
check('one claude_finished queue entry', q.length === 1 && q[0].taskId === 'd101');
await poll(D1); await poll(D3);
check('slot freed: 103 now running', (await task(103)).claude.state === 'running' && (await db.collection('tasks').countDocuments({ 'claude.state': 'running' })) === 2);
// the flush after complete_task may already have sent it; run the cron twice either way
const c1 = await cron(); const c2 = await cron();
const n1 = await db.collection('notifications').find({ kind: 'claude_finished' }).toArray();
check('alert sent exactly once through two cron runs', n1.length === 1 && n1[0].title === 'Claude finished #101', JSON.stringify(n1.map(n => n.title)) + JSON.stringify([c1, c2]));
check('queue entry claimed', (await db.collection('alertQueue').findOne({ _id: q[0]._id })).sentAt !== null);

// ── Blocked by the session -> stopped ──
m = await mcp('log_progress', { task: 102, progress: 30, status: 'Blocked', blocked_reason: 'needs prod credentials' });
let t102 = await task(102);
check('task Blocked by the session -> stopped with reason', t102.claude.state === 'stopped' && /needs prod credentials/.test(t102.claude.note), JSON.stringify(t102.claude) + m.text.slice(0, 100));
await cron();
const n2 = await db.collection('notifications').find({ kind: 'claude_stopped' }).toArray();
check('alert "Claude stopped on #102: reason" once', n2.length === 1 && /^Claude stopped on #102: blocked: needs prod credentials/.test(n2[0].title), JSON.stringify(n2.map(n => n.title)));

// ── session dead with task not Done -> stopped ──
const s103 = (await task(103)).claude.sessionId;
const dev103 = (await task(103)).claude.deviceId === D1.id ? D1 : D3;
await status(dev103, { sessions: [{ sessionId: s103, folderId: dev103 === D1 ? 'f_aaaa1' : 'f_cccc1', state: 'running' }] });
check('running report keeps 103 running', (await task(103)).claude.state === 'running' && (await db.collection('workerSessions').findOne({ _id: s103 })).state === 'running');
await status(dev103, { sessions: [{ sessionId: s103, folderId: dev103 === D1 ? 'f_aaaa1' : 'f_cccc1', state: 'dead' }] });
check('session dead, task not Done -> stopped', (await task(103)).claude.state === 'stopped' && /session ended/.test((await task(103)).claude.note));
await cron();
check('alert for 103 sent once', (await db.collection('notifications').countDocuments({ kind: 'claude_stopped', title: /#103/ })) === 1);

// ── start job failed -> failed, prevStatus restored ──
await db.collection('tasks').updateOne({ ref: 104 }, { $set: { claude: mark(9), status: 'Not Started' } });
await poll(D1); await poll(D3);
let t104 = await task(104);
check('104 claimed after slots free', t104.claude.state === 'running' && t104.status === 'In Progress');
const j104 = await db.collection('workerJobs').findOne({ sessionId: t104.claude.sessionId });
await status(t104.claude.deviceId === D1.id ? D1 : D3, { jobs: [{ id: j104._id, ok: false, error: 'folder not found on this machine' }] });
t104 = await task(104);
check('start job failed -> failed, status restored to Not Started', t104.claude.state === 'failed' && t104.status === 'Not Started' && /could not start/.test(t104.claude.note), JSON.stringify(t104.claude) + t104.status);
await cron();
check('alert for failed start (one)', (await db.collection('notifications').countDocuments({ title: /^Claude stopped on #104/ })) === 1);

// ── reconciler ──
await db.collection('tasks').updateMany({ 'claude.state': 'running' }, { $set: { 'claude.state': 'stopped' } });
// (a) stuck "starting" > 5 min with the job never taken -> requeued
const sidA = randomUUID();
await db.collection('tasks').updateOne({ ref: 105 }, { $set: { status: 'In Progress', claude: { state: 'running', markedAt: new Date(now - 6e5), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(Date.now() - 10 * 60_000), deviceId: D2.id, sessionId: sidA, prevStatus: 'Not Started' } } });
await db.collection('workerSessions').insertOne({ _id: sidA, deviceId: D2.id, folderId: 'f_bbbb1', projectId: 'p2', state: 'starting', startedAt: new Date(Date.now() - 10 * 60_000), updatedAt: new Date(Date.now() - 10 * 60_000), dispatched: true, taskId: 'd105' });
await db.collection('workerJobs').insertOne({ _id: 'j_stuck', deviceId: D2.id, kind: 'start', sessionId: sidA, folderId: 'f_bbbb1', projectId: 'p2', prompt: 'x', createdAt: new Date(), takenAt: null, doneAt: null });
// (b) running, computer silent 20 min -> stopped + alert
const sidB = randomUUID();
await db.collection('devices').updateOne({ _id: D3.id }, { $set: { lastSeenAt: new Date(Date.now() - 20 * 60_000) } });
await db.collection('tasks').updateOne({ ref: 106 }, { $set: { status: 'In Progress', claude: { state: 'running', markedAt: new Date(now - 6e5), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(Date.now() - 30 * 60_000), deviceId: D3.id, sessionId: sidB, prevStatus: 'Not Started' } } });
await db.collection('workerSessions').insertOne({ _id: sidB, deviceId: D3.id, folderId: 'f_cccc1', projectId: 'p1', state: 'running', startedAt: new Date(Date.now() - 30 * 60_000), updatedAt: new Date(Date.now() - 20 * 60_000), dispatched: true, taskId: 'd106' });
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: false } }); // so the requeued task is not re-claimed during the check
await cron();
const t105 = await task(105);
check('stuck starting: requeued, attempt counted, status restored', t105.claude.state === 'queued' && t105.claude.attempts === 1 && t105.status === 'Not Started' && !t105.claude.sessionId, JSON.stringify(t105.claude) + t105.status);
const jj = await db.collection('workerJobs').findOne({ _id: 'j_stuck' });
check('its start job is cancelled and session closed', !!jj.doneAt && jj.ok === false && (await db.collection('workerSessions').findOne({ _id: sidA })).state === 'failed');
const t106 = await task(106);
check('silent computer: running claim stopped', t106.claude.state === 'stopped' && /no news from PC-3/.test(t106.claude.note), JSON.stringify(t106.claude));
check('alert for the silent one, once, none for the requeue', (await db.collection('notifications').countDocuments({ title: /^Claude stopped on #106/ })) === 1 && (await db.collection('notifications').countDocuments({ title: /#105/ })) === 0);
await cron();
check('second cron sends no duplicates', (await db.collection('notifications').countDocuments({ title: /^Claude stopped on #106/ })) === 1);

// ── stuck alert (quiet 20 min via claudeSessions) ──
const sidC = randomUUID();
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: true } });
await db.collection('devices').updateOne({ _id: D1.id }, { $set: { lastSeenAt: new Date(), claudeSessions: { at: new Date(), items: [{ sessionId: sidC, folder: 'folder-f_aaaa1', title: 't', lastActiveAt: new Date(Date.now() - 25 * 60_000), subagentsActive: 0, startedByWorkOs: true, running: true }] } } });
await db.collection('tasks').updateOne({ ref: 104 }, { $set: { status: 'In Progress', claude: { state: 'running', markedAt: new Date(now - 6e5), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(Date.now() - 40 * 60_000), deviceId: D1.id, sessionId: sidC, prevStatus: 'Not Started' } } });
await db.collection('workerSessions').insertOne({ _id: sidC, deviceId: D1.id, folderId: 'f_aaaa1', projectId: 'p1', state: 'running', startedAt: new Date(Date.now() - 40 * 60_000), updatedAt: new Date(), dispatched: true, taskId: 'd104' });
await cron(); await cron();
const stuck = await db.collection('notifications').find({ kind: 'claude_stuck' }).toArray();
check('stuck alert once for a quiet running session', stuck.length === 1 && /Claude may be stuck on #104/.test(stuck[0].title), JSON.stringify(stuck.map(s => s.title)));
check('stuck did not stop it', (await task(104)).claude.state === 'running');

await finish();
