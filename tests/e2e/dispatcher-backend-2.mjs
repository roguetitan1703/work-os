// Dispatcher backend, part 2: boilerplate note protection, restore strips claude, stale folder, sanitised alert text, job failures, atomic hand-out. Seed profile: base (it needs the notes and projects of that seed).
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

for (const n of ['tasks', 'activity', 'alertLog', 'alertQueue', 'notifications', 'workerSessions', 'workerJobs', 'workerFolders', 'devices', 'settings', 'policyEvents', 'trash']) await db.collection(n).deleteMany({});
const D1 = await mkDevice('PC-1');
await db.collection('workerFolders').insertMany([link(D1, 'f_aaaa1', 'p1')]);
await db.collection('settings').insertOne({ _id: 'dispatcher', enabled: true, maxConcurrent: 2, boilerplateNoteId: 'n1' });
await db.collection('counters').updateOne({ _id: 'task' }, { $set: { seq: 300 } }, { upsert: true });
await status(D1);

// 1. boilerplate note protection
const n1before = await db.collection('notes').findOne({ _id: 'n1' });
let m = await mcp('write_note', { note_id: 'n1', append: 'INJECTED' });
check('MCP write_note on the boilerplate refused', m.isError && /boilerplate/.test(m.text), m.text.slice(0, 200));
m = await mcp('write_note', { parent_id: 'n1', title: 'child', body: 'x' });
check('MCP sub-page under the boilerplate refused', m.isError && /boilerplate/.test(m.text), m.text.slice(0, 200));
m = await mcp('delete_note', { note_id: 'n1', title: n1before.title });
check('MCP delete_note on the boilerplate refused', m.isError && /boilerplate/.test(m.text), m.text.slice(0, 200));
m = await mcp('apply_changes', { ops: [{ op: 'write_note', note_id: 'n1', append: 'INJECTED2' }] });
check('apply_changes note op on the boilerplate refused', /boilerplate/.test(m.text), m.text.slice(0, 300));
const n1after = await db.collection('notes').findOne({ _id: 'n1' });
check('boilerplate note unchanged', n1after.body === n1before.body && !n1after.deletedAt && n1after.updatedAt.getTime() === n1before.updatedAt.getTime());
m = await mcp('write_note', { note_id: 'n2', append: 'fine' });
check('another note is still writable by MCP', !m.isError && /fine/.test((await db.collection('notes').findOne({ _id: 'n2' })).body), m.text.slice(0, 200));

// 2. restore strips claude
await db.collection('trash').insertOne({ _id: 'd900', ref: 900, title: 'old trash', task: mk(900, 'old trash', { projectId: 'p1', claude: mark(1) }), activity: [], deletedAt: new Date(), deletedBy: 'me', reason: '' });
m = await mcp('restore_task', { task: 900 });
check('restore_task strips claude', !m.isError && !(await task(900)).claude, m.text.slice(0, 200));

// 3. stale folderKey
await db.collection('tasks').insertOne(mk(910, 'stale folder', { projectId: 'p1', claude: mark(2, { folderKey: `${D1.id}:f_gone0` }) }));
await poll(D1);
let t = await task(910);
check('stale folderKey: mark cleared to stopped', t.claude.state === 'stopped' && /folder no longer linked/.test(t.claude.note), JSON.stringify(t.claude));
await cron(); await cron();
check('one alert for it', (await db.collection('notifications').countDocuments({ title: /^Claude stopped on #910: folder no longer linked/ })) === 1);

// 4. alert text sanitised
await db.collection('tasks').insertOne(mk(920, 'mentions', { projectId: 'p1', status: 'In Progress', claude: { state: 'running', markedAt: new Date(), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(), deviceId: D1.id, sessionId: randomUUID(), prevStatus: 'Not Started' } }));
await mcp('log_progress', { task: 920, progress: 10, status: 'Blocked', blocked_reason: 'ping @everyone and @here <@123456> see [docs](http://evil.example/x) @om' });
await cron();
const nn = await db.collection('notifications').findOne({ title: /#920/ });
check('stopped alert has no mentions or links', nn && !/@|<|\]\(|evil/.test(nn.title + nn.body) && /everyone/.test(nn.title), JSON.stringify(nn));

// 5. persistent job failure ends as failed
await db.collection('workerJobs').deleteMany({});
await db.collection('workerJobs').insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: 'j_full' + i, deviceId: D1.id, kind: 'resume', sessionId: randomUUID(), createdAt: new Date(), takenAt: new Date(), doneAt: null })));
await db.collection('tasks').insertOne(mk(930, 'job always fails', { projectId: 'p1', claude: mark(3) }));
await poll(D1); t = await task(930); const a1 = t.claude.attempts, s1 = t.claude.state;
await poll(D1); await poll(D1); t = await task(930);
check('first failure requeued with attempt counted', a1 === 1 && s1 === 'queued', `${a1} ${s1}`);
check('third failure ends as failed (not retried every poll)', t.claude.state === 'failed' && /could not start/.test(t.claude.note) && t.status === 'Not Started', JSON.stringify(t.claude) + t.status);
await db.collection('workerJobs').deleteMany({}); await db.collection('workerSessions').deleteMany({});

// 6. status clobber
const sid6 = randomUUID();
await db.collection('tasks').insertOne(mk(940, 'status kept', { projectId: 'p1', status: 'Not Started', claude: { state: 'running', markedAt: new Date(), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId, claimedAt: new Date(Date.now() - 10 * 60_000), deviceId: D1.id, sessionId: sid6, prevStatus: 'In Progress' } }));
await db.collection('workerSessions').insertOne({ _id: sid6, deviceId: D1.id, folderId: 'f_aaaa1', projectId: 'p1', state: 'starting', startedAt: new Date(Date.now() - 10 * 60_000), updatedAt: new Date(Date.now() - 10 * 60_000), dispatched: true, taskId: 'd940' });
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: false } });
await cron();
t = await task(940);
check('requeue keeps a status Om changed (Not Started, not prevStatus)', t.claude.state === 'queued' && t.status === 'Not Started', t.claude.state + t.status);

// 7. atomic hand-out
await db.collection('workerJobs').insertOne({ _id: 'j_once', deviceId: D1.id, kind: 'resume', sessionId: randomUUID(), folderId: 'f_aaaa1', createdAt: new Date(), takenAt: null, doneAt: null });
const ps = await Promise.all(Array.from({ length: 8 }, () => poll(D1)));
check('8 simultaneous polls: the job is handed out once', ps.flatMap(x => x.body.jobs).filter(j => j.id === 'j_once').length === 1);

await finish();
