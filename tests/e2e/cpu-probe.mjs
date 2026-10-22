// Counts database operations per request type (docs/cpu.md). Not part of the default suites:
//   E2E_EXTRA='cpu|cpu-probe.mjs|base|plain' SKIP_BUILD=1 bash tests/e2e/run.sh cpu
// Turns the mongod profiler on for the throwaway database and counts what each request caused. Seed profile: base.
import { B, PW, check, db, mkDevice, finish, launch, login } from './lib.mjs';

const dev = await mkDevice('probe-pc');
// A realistic amount of data: 400 tasks (150 open, with descriptions and checklists), 150 notes of about 20 KB.
{
  const pids = (await db.collection('projects').find({}, { projection: { _id: 1 } }).toArray()).map(p => p._id);
  const now = new Date();
  const para = 'Some longer text about the work, what was decided and why. '.repeat(6);
  const tasks = Array.from({ length: 400 }, (_, i) => ({ _id: 'cpu' + i, ref: 5000 + i, title: 'Probe task ' + i, description: para, mode: null, projectId: pids[i % Math.max(pids.length, 1)] ?? null, priority: 'P2', status: i % 8 < 3 ? 'Not Started' : i % 8 === 3 ? 'In Progress' : 'Done', tags: ['probe'], due: i % 5 === 0 ? '2026-01-01' : null, start: null, estimateMins: 30, progress: 0, checklist: [{ id: 'c' + i, text: 'step', done: false }], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', createdAt: now, updatedAt: now, doneAt: i % 8 > 3 ? now : null, doneOn: i % 8 > 3 ? '2026-10-21' : null, doneBy: null }));
  await db.collection('tasks').insertMany(tasks);
  const block = i => ({ id: 'b' + i, type: 'paragraph', props: {}, content: [{ type: 'text', text: para, styles: {} }], children: [] });
  const blocks = Array.from({ length: 50 }, (_, i) => block(i));
  const notes = Array.from({ length: 150 }, (_, i) => ({ _id: 'cpun' + i, title: 'Probe note ' + i, blocks, body: para.repeat(50), parentId: null, taskId: i < 100 ? 'cpu' + i : null, projectId: i < 100 ? null : (pids[0] ?? null), archived: false, createdBy: 'me', createdAt: now, updatedBy: 'me', updatedAt: now, deletedAt: null }));
  await db.collection('notes').insertMany(notes);
}
await db.command({ profile: 2 });
const prof = db.collection('system.profile');
async function count(label, fn) {
  await new Promise(r => setTimeout(r, 400));
  const t0 = new Date();
  const res = await fn();
  await new Promise(r => setTimeout(r, 700)); // after() work (alert flush, markSeen) finishes
  const docs = await prof.find({ ts: { $gte: t0 }, ns: { $not: /system\.profile|\$cmd$|\.indexes$/ } }).toArray();
  const ops = docs.filter(d => !['getmore'].includes(d.op));
  const by = {};
  for (const d of ops) { const k = `${d.ns.split('.').pop()}:${d.command ? Object.keys(d.command)[0] : d.op}`; by[k] = (by[k] ?? 0) + 1; }
  const kb = Math.round(ops.reduce((a, d) => a + (d.responseLength ?? 0), 0) / 1024);
  console.log(`COUNT ${label}: ${ops.length} ops, ${ops.reduce((a, d) => a + (d.nreturned ?? 0), 0)} docs, ${kb} KB  ${JSON.stringify(by)}`);
  return { n: ops.length, res };
}

const browser = await launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await login(page);
const cookie = (await ctx.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
const get = p => () => fetch(B + p, { headers: { cookie } }).then(async r => { await r.text(); return r.status; });
const warm = await fetch(B + '/today', { headers: { cookie } }); await warm.text(); // first request pays the one-time setup

const out = {};
out.today = await count('/today (page + layout)', get('/today'));
out.claude = await count('/claude (page + layout)', get('/claude'));
out.tasks = await count('/tasks (page + layout)', get('/tasks'));
out.projects = await count('/projects (page + layout)', get('/projects'));
out.notes = await count('/notes (page + layout)', get('/notes'));
const poll = () => fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${dev.key}` } }).then(r => r.status);
await poll();
out.pollOff = await count('worker idle poll, dispatcher off', poll);
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: true, maxConcurrent: 2, boilerplateNoteId: 'n1' } }, { upsert: true });
await poll();
out.pollOn = await count('worker idle poll, dispatcher on, nothing queued', poll);
await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: false } });
const mcpCall = () => fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${process.env.MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }) }).then(r => r.status);
await mcpCall();
out.mcp = await count('MCP call (list_projects)', mcpCall);
const mcpTasks = () => fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${process.env.MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tasks', arguments: { limit: 5 } } }) }).then(r => r.status);
out.mcpTasks = await count('MCP call (list_tasks)', mcpTasks);

check('pages rendered', Object.entries(out).filter(([k]) => ['today', 'claude', 'tasks', 'projects', 'notes'].includes(k)).every(([, v]) => v.res === 200));
await db.command({ profile: 0 });
await browser.close();
await finish();
