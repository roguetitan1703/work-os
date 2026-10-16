// Shared seed. Usage: node seed.mjs <profile>   (run.sh calls it before every suite, on an emptied database)
//   none   empty database
//   base   direct-insert fixtures: 2 projects, tasks (stale / archived / done / due), trash, 2 notes, 1 Claude item
//          (Review hub and global search)
//   nav    3 projects, 16 tasks over all modes, comments, notes, 2 Claude items waiting on Om (navigation suites)
//   today  Alpha Client with 7 overdue / 3 due today / in progress / blocked tasks, 3 waiting Claude items,
//          a device with 2 running sessions (Today page)
// Suites that need something else seed themselves; they start from the same emptied database.
import { db, mc, call } from './lib.mjs';

export async function wipe() {
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).deleteMany({});
}
// calendar date in Asia/Kolkata, n days from today
export const day = n => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

async function seedBase() {
  const now = new Date(); const ago = d => new Date(now - d * 864e5);
  const base = { description: '', mode: null, projectId: null, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', doneAt: null, doneOn: null, doneBy: null };
  await db.collection('projects').insertMany([
    { _id: 'p1', name: 'AKAR', nameLower: 'akar', client: 'Acme', description: 'Invoice app', status: 'active', createdAt: now, updatedAt: now },
    { _id: 'p2', name: 'Delpat Site', nameLower: 'delpat site', client: '', description: '', status: 'active', createdAt: now, updatedAt: now },
  ]);
  const T = (ref, title, o = {}) => ({ ...base, _id: 't' + ref, ref, title, createdAt: ago(40), updatedAt: ago(1), ...o });
  await db.collection('tasks').insertMany([
    T(1, 'Fix webhook retries', { projectId: 'p1', due: day(-2) }),
    T(2, 'Send invoice to Acme', { projectId: 'p1' }),
    T(3, 'Old stale idea', { updatedAt: ago(30), projectId: 'p2' }),
    T(4, 'Another stale one', { updatedAt: ago(20) }),
    T(5, 'Shipped login page', { status: 'Done', doneAt: ago(2), doneOn: day(-2), doneBy: 'me', projectId: 'p2' }),
    T(6, 'Archived logo task', { archived: true, status: 'Done', doneAt: ago(10), doneOn: day(-10), doneBy: 'me', projectId: 'p1' }),
    T(7, 'Archived research', { archived: true, updatedAt: ago(5) }),
  ]);
  await db.collection('counters').updateOne({ _id: 'taskRef' }, { $set: { seq: 20 } }, { upsert: true });
  await db.collection('trash').insertOne({ _id: 'tr1', ref: 8, title: 'Deleted draft', task: T(8, 'Deleted draft', { projectId: 'p1' }), activity: [], deletedAt: ago(2), deletedBy: 'me', reason: 'duplicate' });
  const note = (_id, title, body, projectId) => ({ _id, title, blocks: [], body, parentId: null, taskId: null, projectId, archived: false, createdBy: 'me', createdAt: now, updatedBy: 'me', updatedAt: now, deletedAt: null });
  await db.collection('notes').insertMany([
    note('n1', 'AKAR scope', 'The header logo must use the vector version. Quarterly invoice export.', 'p1'),
    note('n2', 'Call notes', 'Anaspure wants a webhook demo [draft] (v2).', null),
  ]);
  await db.collection('claudeItems').insertOne({ _id: 'c1', ref: 12, projectId: 'p1', title: 'Reorder invoice export', kind: 'task', state: 'queued', next: false, order: 1, why: 'x', doneWhen: 'y', note: '', parts: [], blockedBy: null, waitingOnOm: '', gitRef: '', claimedBy: null, createdBy: 'me', createdAt: now, updatedAt: now, doneAt: null, log: [] });
}

async function seedNav() {
  for (const n of ['Alpha Client', 'Beta Product', 'Gamma Internal']) await call('add_project', { name: n });
  const T = [
    { title: 'Overdue invoice follow-up', project: 'Alpha Client', priority: 'P1', due: day(-5), mode: 'Client Delivery' },
    { title: 'Overdue contract review', project: 'Alpha Client', priority: 'P2', due: day(-6) },
    { title: 'Due today ship build', project: 'Beta Product', priority: 'P1', due: 'today', mode: 'Code & Dev' },
    { title: 'Due today write email', project: 'Beta Product', priority: 'P3', due: 'today' },
    { title: 'In progress refactor', project: 'Beta Product', priority: 'P2', status: 'In Progress', due: '+2d', mode: 'Code & Dev' },
    { title: 'In progress proposal', project: 'Alpha Client', priority: 'P2', status: 'In Progress', mode: 'Outreach & Sales' },
    { title: 'Blocked waiting on client', project: 'Alpha Client', priority: 'P2', status: 'Blocked', blocked_reason: 'Need access', due: '+5d' },
    { title: 'P1 urgent fix', project: 'Gamma Internal', priority: 'P1', due: 'tomorrow' },
    { title: 'No due plan roadmap', project: 'Gamma Internal', priority: 'P3', mode: 'Research & Planning' },
    { title: 'No due tidy docs', priority: 'P4' },
    { title: 'Checklist task', project: 'Gamma Internal', priority: 'P2', due: '+4d', checklist: ['one', 'two'], tags: ['x'] },
    { title: 'Growth experiment', project: 'Beta Product', priority: 'P3', mode: 'Growth', due: '+7d' },
    { title: 'Admin taxes', priority: 'P2', mode: 'Business Admin', due: '+1d' },
    { title: 'Founder decision pricing', priority: 'P1', mode: 'Founder Decisions', due: 'today' },
    { title: 'Team 1:1 prep', priority: 'P3', mode: 'Team Direction', due: '+3d' },
    { title: 'Dep target task', project: 'Gamma Internal', priority: 'P3' },
  ];
  const refs = [];
  for (const t of T) { const r = await call('add_task', t); if (r.ERROR) throw new Error('seed add_task: ' + r.ERROR); refs.push(r.created.ref); }
  await call('add_comment', { task: refs[0], note: 'seed comment one' });
  await call('add_comment', { task: refs[2], note: 'seed comment two' });
  for (const [p, t] of [['Alpha Client', 'Alpha notes'], ['Beta Product', 'Beta spec'], ['Gamma Internal', 'Gamma ideas']]) await call('write_note', { project: p, title: t, body: '# ' + t + '\n\nSome body text.' });
  const P = 'Alpha Client';
  for (const t of ['Confirm invoice export column order', 'Choose logo for the invoice header']) {
    const r = await call('update_claude_items', { project: P, ops: [{ op: 'add', project: P, kind: 'bug', title: t, why: 'Fixture for the nav badge test on the throwaway app, nothing real at all.', done_when: 'The nav badge check passes on the throwaway app.', waiting_on_om: 'Which one should we pick for this fixture?' }] });
    if (r.ERROR) throw new Error('seed claude items: ' + r.ERROR);
  }
}

async function seedToday() {
  const P = 'Alpha Client';
  await call('add_project', { name: P, code: [{ remote: 'x/alpha' }] });
  const add = async (title, extra = {}) => { const r = await call('add_task', { title, project: P, ...extra }); if (r.ERROR) throw new Error('seed add_task: ' + r.ERROR); };
  for (let i = 1; i <= 7; i++) await add(`Overdue task ${i}`, { priority: i % 2 ? 'P1' : 'P2', due: day(-i), mode: i % 3 ? 'Client Delivery' : 'Code & Dev' });
  for (let i = 1; i <= 3; i++) await add(`Due today task ${i}`, { priority: 'P1', due: 'today', mode: 'Code & Dev' });
  await add('In progress task A', { status: 'In Progress', priority: 'P2', mode: 'Code & Dev' });
  await add('In progress task B', { status: 'In Progress', priority: 'P3' });
  await add('Blocked task A', { status: 'Blocked', priority: 'P2' });
  await add('Code NOW only task X', { priority: 'P2', mode: 'Code & Dev' });
  await add('Code NOW only task Y', { priority: 'P3', mode: 'Code & Dev' });
  await add('Plain P1 up next', { priority: 'P1', mode: 'Growth' });
  await add('Plain P4 backlog', { priority: 'P4' });
  for (const t of ['Which logo should the header use?', 'Pick option A or B please', 'Third question here']) {
    const r = await call('update_claude_items', { project: P, ops: [{ op: 'add', project: P, kind: 'bug', title: 'Fixture ' + t.slice(0, 12), why: 'Fixture for the Today card test on the throwaway app, nothing real at all here.', done_when: 'The Today check passes.', waiting_on_om: t }] });
    if (r.ERROR) throw new Error('seed claude items: ' + r.ERROR);
  }
  const proj = await db.collection('projects').findOne({ name: P });
  const now = new Date();
  await db.collection('devices').insertOne({ _id: 'dev1', name: 'Om-PC', hash: 'h1', prefix: 'p1', createdAt: now, lastSeenAt: now, revokedAt: null, activity: { sessions: 2, sessionsWorkOs: 1, sessionsOther: 1, sessionsActive: 1, subagents: 3, at: now } });
  await db.collection('workerFolders').insertOne({ _id: 'dev1:f1', deviceId: 'dev1', folderId: 'f1', name: 'alpha', git: true, projectId: proj._id, linkedAt: now, seenAt: now, missing: false });
  for (const id of ['s1', 's2']) await db.collection('workerSessions').insertOne({ _id: id, deviceId: 'dev1', folderId: 'f1', projectId: proj._id, state: 'running', startedAt: now, updatedAt: now });
}

const profile = process.argv[2] || 'none';
const profiles = { none: async () => {}, base: seedBase, nav: seedNav, today: seedToday };
if (!profiles[profile]) { console.error('unknown seed profile ' + profile); process.exit(2); }
await wipe();
await profiles[profile]();
console.log(`seeded ${profile}`);
await mc.close();
