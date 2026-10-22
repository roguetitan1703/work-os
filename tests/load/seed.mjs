// Seeds one organization the size of the Delpat team (tests/load/README.md), on the throwaway database only:
//   20 people (the e2e owner + 19 members, 2 of them admins), each with a timezone, a schedule, a Claude chat key and a
//   computer (worker key) with folders linked to their projects;
//   50 projects (42 shared, 8 private), 2,000 tasks (about 600 open, with descriptions, checklists, assignees,
//   dependencies), about 6,000 history entries, 300 notes, 150 Claude items, a few worker sessions.
// Writes the team (ids and throwaway keys) to team.json beside E2E_STATE, for sim.mjs and the budgets suite.
// Usage: node seed.mjs [--users 20] [--tasks 2000]
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { rawDb, mc, makeIdentity, makeUser, mkKey, giveLegacyWeek, setProfile, sha, EMAIL, PW } from '../e2e/lib.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
import { TEAM_FILE } from './team.mjs';

const USERS = arg('users', 20);
const TASKS = arg('tasks', 2000);
const PROJECTS = 50;
const MODES = ['Code & Dev', 'Client Delivery', 'Team Direction', 'Outreach & Sales', 'Growth', 'Research & Planning', 'Founder Decisions', 'Business Admin'];

// A fixed pseudo-random sequence: the same data on every run.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = a => a[Math.floor(rnd() * a.length)];
const day = n => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const para = 'We agreed to keep the first version small, ship it to the client for a look, then fix what they find. ';

for (const { name } of await rawDb.listCollections({}, { nameOnly: true }).toArray()) await rawDb.collection(name).deleteMany({});
const owner = await makeIdentity();
const people = [{ email: EMAIL, userId: owner.userId, name: 'E2E Owner', role: 'owner' }];
for (let i = 1; i < USERS; i++) {
  const email = `load-u${String(i).padStart(2, '0')}@example.test`;
  const role = i <= 2 ? 'admin' : 'member';
  const u = await makeUser({ email, name: `Person ${i}`, orgId: owner.orgId, role });
  people.push({ email, userId: u.userId, name: `Person ${i}`, role });
}
const orgId = owner.orgId;
const now = new Date();
const ago = d => new Date(now.getTime() - d * 864e5);

// ── people: profile, schedule, keys, computers ──
for (const p of people) {
  if (p.userId !== owner.userId) {
    await setProfile({ userId: p.userId, orgId }, { timezone: 'Asia/Kolkata' });
    await giveLegacyWeek({ userId: p.userId, orgId });
  }
  p.claudeKey = await mkKey({ agent: 'claude', userId: p.userId, orgId, name: 'load chat' });
  p.deviceKey = 'wkr_' + randomBytes(32).toString('base64url');
  p.deviceId = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: p.deviceId, name: `${p.name} PC`, ownerId: p.userId, orgId, hash: sha(p.deviceKey), prefix: p.deviceKey.slice(0, 8), createdAt: now, lastSeenAt: null, revokedAt: null });
}

// ── projects ──
const projects = [];
for (let i = 0; i < PROJECTS; i++) {
  const shared = i < 42;
  const ownerP = people[i % people.length];
  const name = `${pick(['Acme', 'Grant', 'Nimbus', 'Orbit', 'Delta', 'Kite', 'Lumen', 'Atlas'])} ${pick(['Portal', 'Site', 'App', 'Leads', 'Billing', 'Ops', 'CRM', 'Launch'])} ${i + 1}`;
  const _id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  projects.push({ _id, orgId, ownerId: ownerP.userId, visibility: shared ? 'org' : 'private', name, nameLower: name.toLowerCase(), client: pick(['Acme', 'Grant', '']), description: para, status: i % 10 === 9 ? 'paused' : 'active', code: [{ remote: `delpat/${_id}` }], createdAt: ago(90), updatedAt: ago(i % 7) });
}
await rawDb.collection('projects').insertMany(projects);

// ── tasks + history ──
const STAT = () => {
  const r = rnd();
  return r < 0.62 ? 'Done' : r < 0.66 ? 'Dropped' : r < 0.84 ? 'Not Started' : r < 0.95 ? 'In Progress' : 'Blocked';
};
const tasks = [];
const activity = [];
for (let i = 0; i < TASKS; i++) {
  const proj = rnd() < 0.93 ? projects[Math.floor(rnd() * projects.length)] : null;
  const shared = proj ? proj.visibility === 'org' : false;
  const ownerId = proj && !shared ? proj.ownerId : pick(people).userId;
  const status = STAT();
  const open = status !== 'Done' && status !== 'Dropped';
  const created = ago(5 + Math.floor(rnd() * 80));
  const r = rnd();
  const due = !open ? (rnd() < 0.5 ? day(-Math.floor(rnd() * 60)) : null) : r < 0.12 ? day(-1 - Math.floor(rnd() * 10)) : r < 0.18 ? day(0) : r < 0.5 ? day(1 + Math.floor(rnd() * 20)) : null;
  const t = {
    _id: 'lt' + i, ref: i + 1, orgId, ownerId, visibility: proj ? proj.visibility : rnd() < 0.5 ? 'org' : 'private',
    assigneeId: shared && rnd() < 0.6 ? pick(people).userId : null,
    title: `${pick(['Fix', 'Ship', 'Review', 'Write', 'Plan', 'Call', 'Send', 'Check'])} ${pick(['invoice export', 'login page', 'lead list', 'webhook retries', 'pricing page', 'onboarding mail', 'report', 'contract'])} ${i + 1}`,
    description: rnd() < 0.5 ? para.repeat(1 + Math.floor(rnd() * 4)) : '',
    mode: rnd() < 0.8 ? pick(MODES) : null, projectId: proj?._id ?? null,
    priority: pick(['P1', 'P2', 'P2', 'P3', 'P3', 'P4']), status, tags: rnd() < 0.3 ? [pick(['billing', 'ui', 'client', 'infra'])] : [],
    due, start: null, estimateMins: rnd() < 0.5 ? pick([15, 30, 60, 120]) : null, progress: open ? Math.floor(rnd() * 5) * 20 : 100,
    checklist: rnd() < 0.3 ? Array.from({ length: 2 + Math.floor(rnd() * 5) }, (_, k) => ({ id: `c${i}_${k}`, text: 'Step ' + (k + 1), done: rnd() < 0.5 })) : [],
    links: rnd() < 0.1 ? [{ label: 'Doc', url: 'https://example.test/doc' }] : [], blockedReason: status === 'Blocked' ? 'Waiting on the client' : '',
    dependsOn: [], recurrence: null, nextRef: null, archived: !open && rnd() < 0.2,
    createdBy: { kind: 'user', userId: ownerId }, createdAt: created, updatedAt: ago(Math.floor(rnd() * 5)),
    doneAt: open ? null : ago(Math.floor(rnd() * 60)), doneOn: null, doneBy: open ? null : { kind: 'user', userId: ownerId },
  };
  if (!open) t.doneOn = t.doneAt.toISOString().slice(0, 10);
  if (open && i > 10 && rnd() < 0.05) t.dependsOn = ['lt' + (i - 1 - Math.floor(rnd() * 10))];
  tasks.push(t);
  const n = 1 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const by = k === 0 ? ownerId : pick(people).userId;
    activity.push({ _id: `la${i}_${k}`, orgId, ownerId: t.ownerId, visibility: t.visibility, taskId: t._id, taskRef: t.ref, taskTitle: t.title, at: new Date(created.getTime() + k * 36e5), actor: rnd() < 0.2 ? { kind: 'agent', agent: 'claude', userId: by } : { kind: 'user', userId: by }, type: k === 0 ? 'created' : pick(['comment', 'updated', 'progress']), ...(k ? { note: 'Moved on with it; the client saw the draft.' } : {}) });
  }
}
await rawDb.collection('tasks').insertMany(tasks);
await rawDb.collection('activity').insertMany(activity);
await rawDb.collection('counters').insertOne({ _id: `task:${orgId}`, seq: TASKS, orgId });

// ── notes (blocks are the source of truth; body is derived markdown) ──
const block = k => ({ id: 'b' + k, type: 'paragraph', props: {}, content: [{ type: 'text', text: para, styles: {} }], children: [] });
const notes = [];
for (let i = 0; i < 300; i++) {
  const taskNote = i < 150;
  const t = taskNote ? tasks[i * 7] : null;
  const proj = taskNote ? null : projects[i % projects.length];
  const nBlocks = 5 + Math.floor(rnd() * 30);
  notes.push({ _id: 'ln' + i, orgId, ownerId: t ? t.ownerId : proj.ownerId, visibility: t ? t.visibility : proj.visibility, title: taskNote ? t.title : `Notes ${i}`, blocks: Array.from({ length: nBlocks }, (_, k) => block(k)), body: para.repeat(nBlocks), parentId: null, taskId: t?._id ?? null, projectId: proj?._id ?? null, archived: false, createdBy: { kind: 'user', userId: people[0].userId }, createdAt: ago(30), updatedBy: { kind: 'user', userId: people[0].userId }, updatedAt: ago(i % 20), deletedAt: null });
}
await rawDb.collection('notes').insertMany(notes);

// ── Claude items ──
const items = [];
for (let i = 0; i < 150; i++) {
  const proj = projects[i % 42];
  const waiting = rnd() < 0.15 ? pick(people).userId : null;
  items.push({ _id: 'lc' + i, orgId, ownerId: proj.ownerId, visibility: 'org', ref: i + 1, projectId: proj._id, title: `Claude item ${i + 1}`, kind: pick(['feature', 'bug', 'debt', 'idea']), state: pick(['queued', 'queued', 'active', 'done', 'done', 'blocked']), next: false, order: i, why: para, doneWhen: 'It works on the staging site.', note: '', parts: [], blockedBy: null, waitingOn: waiting, waitingText: waiting ? 'Which option should we take?' : '', gitRef: '', claimedBy: null, createdBy: { kind: 'agent', agent: 'claude-code', userId: proj.ownerId }, createdAt: ago(20), updatedAt: ago(i % 9), doneAt: null, log: [] });
}
await rawDb.collection('claudeItems').insertMany(items);
await rawDb.collection('counters').insertOne({ _id: `claudeItems:${orgId}`, seq: 150, orgId });

// ── computers: folders linked to a few projects each, a couple of old sessions ──
for (const [n, p] of people.entries()) {
  const mine = projects.filter((x, k) => x.visibility === 'org' ? k % people.length === n || (k + 7) % people.length === n : x.ownerId === p.userId).slice(0, 3);
  p.folders = [];
  for (const [k, proj] of mine.entries()) {
    const folderId = 'f' + k;
    p.folders.push({ folderId, name: proj._id, projectId: proj._id });
    await rawDb.collection('workerFolders').insertOne({ _id: `${p.deviceId}:${folderId}`, orgId, ownerId: p.userId, deviceId: p.deviceId, folderId, name: proj._id, git: true, remote: `delpat/${proj._id}`, projectId: proj._id, linkedAt: ago(3), seenAt: now, missing: false });
  }
}

// ── three people use the dispatcher (Tasks for Claude): on, with one of their own notes as the boilerplate ──
for (const p of people.slice(3, 6)) {
  const own = notes.find(x => x.ownerId === p.userId) ?? (await rawDb.collection('notes').insertOne({ _id: 'lnb' + p.userId, orgId, ownerId: p.userId, visibility: 'private', title: 'Read me first', blocks: [block(0)], body: para, parentId: null, taskId: null, projectId: null, archived: false, createdBy: { kind: 'user', userId: p.userId }, createdAt: now, updatedBy: { kind: 'user', userId: p.userId }, updatedAt: now, deletedAt: null }), { _id: 'lnb' + p.userId });
  await rawDb.collection('settings').insertOne({ _id: `dispatcher:${p.userId}`, area: 'dispatcher', orgId, userId: p.userId, enabled: true, maxConcurrent: 2, boilerplateNoteId: own._id, updatedAt: now });
  p.dispatcher = true;
  // Open tasks in the projects their computer has linked: what they give to Claude during the day.
  const linked = new Set(p.folders.map(f => f.projectId));
  p.giveTasks = tasks.filter(t => t.status === 'Not Started' && linked.has(t.projectId) && (t.visibility === 'org' || t.ownerId === p.userId)).slice(0, 4).map(t => t.ref);
}

const team = { orgId, password: PW, people: people.map(({ email, userId, name, role, claudeKey, deviceKey, deviceId, folders, dispatcher = false, giveTasks = [] }) => ({ email, userId, name, role, claudeKey, deviceKey, deviceId, folders, dispatcher, giveTasks })), projects: projects.map(p => ({ id: p._id, visibility: p.visibility, ownerId: p.ownerId })), tasks: tasks.map(t => ({ id: t._id, ref: t.ref, ownerId: t.ownerId, visibility: t.visibility, projectId: t.projectId, open: t.status !== 'Done' && t.status !== 'Dropped' })) };
fs.writeFileSync(TEAM_FILE, JSON.stringify(team));
const open = tasks.filter(t => t.status !== 'Done' && t.status !== 'Dropped').length;
console.log(`seeded ${people.length} people, ${projects.length} projects, ${tasks.length} tasks (${open} open), ${activity.length} history, ${notes.length} notes, ${items.length} Claude items`);
await mc.close();
