// Cost of one request of each kind, one at a time (tests/load/README.md): database operations, documents and keys
// examined, collection scans and response bytes from the mongod profiler and the client; CPU milliseconds and bytes
// sent (compressed) from the server meter when it runs (tests/load/run.sh). Nothing else may run meanwhile.
//   LOAD_SCRIPT=probe.mjs SKIP_BUILD=1 bash tests/load/run.sh
// Also used by sim.mjs (before the day) and by the budgets suite (tests/e2e/budgets.mjs).
import { rawDb } from '../e2e/lib.mjs';
import { Browser, cookieFor, mcpCall, treeFor } from './clients.mjs';
import { meter, profilerOn } from './measure.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The request kinds measured, for a person (team.json entry) whose visible task/project/note ids are given. */
function kinds(b, person, ids) {
  const open = [...ids.openTasks];
  const nextOpen = () => open.shift();
  const doc = { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
  const nav = (p, from = '/today') => () => { b.path = from; return b.navOnly(p); };
  const t = ids.tasks[0];
  const pr = ids.projects[0];
  const n = ids.notes[0];
  let pri = 0;
  return [
    ['page /today', () => b.get('page', '/today', doc)],
    ['rsc /today', nav('/today', '/tasks')],
    ['rsc /tasks', nav('/tasks')],
    ['rsc /projects', nav('/projects')],
    ['rsc /projects/[id]', nav(`/projects/${pr}`)],
    ['rsc /tasks/[id]', nav(`/tasks/${t}`)],
    ['rsc /notes', nav('/notes')],
    ['rsc /notes/[id]', nav(`/notes/${n}`)],
    ['rsc /claude', nav('/claude')],
    ['refresh /claude', () => { b.path = '/claude'; return b.refreshOnly(); }],
    ['refresh /today', () => { b.path = '/today'; return b.refreshOnly(); }],
    ['prefetch /tasks/[id]', () => { b.path = '/today'; return b.prefetchOne(`/tasks/${t}`, false); }],
    ['prefetch-tree /tasks/[id]', () => { b.path = '/today'; return b.prefetchOne(`/tasks/${t}`, true); }],
    ['prefetch /notes/[id]', () => { b.path = '/notes'; return b.prefetchOne(`/notes/${n}`, false); }],
    ['action complete (Today)', () => { b.path = '/today'; return b.actionOnly('completeTaskAction', [nextOpen()]); }],
    ['action update (Tasks)', () => { b.path = '/tasks'; return b.actionOnly('updateTaskAction', [t, { priority: ['P2', 'P3'][pri++ % 2] }]); }],
    ['stream /api/stream (connect)', async () => { const ac = new AbortController(); const r = await fetch(b.base + '/api/stream', { headers: { cookie: b.cookie }, signal: ac.signal }); const rd = r.body.getReader(); await rd.read(); ac.abort(); }],
    ['api /api/worker/jobs', () => fetch(b.base + '/api/worker/jobs', { headers: { authorization: `Bearer ${person.deviceKey}` } }).then(r => r.text())],
    ['api /api/worker/status', () => fetch(b.base + '/api/worker/status', { method: 'POST', headers: { authorization: `Bearer ${person.deviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ worker: { version: '0.1.0', os: 'win32', allowPrompts: false }, jobs: [], sessions: [], activity: { sessions: 1, sessionsWorkOs: 0, sessionsOther: 1, sessionsActive: 0, subagents: 0 }, claudeSessions: [] }) }).then(r => r.text())],
    ['mcp list_tasks', () => mcpCall(person.claudeKey, 'list_tasks', { limit: 20 })],
    ['mcp get_task', () => mcpCall(person.claudeKey, 'get_task', { task: ids.refs[0] })],
    ['mcp update_task', () => mcpCall(person.claudeKey, 'update_task', { task: ids.refs[1], priority: ['P2', 'P3'][pri++ % 2], note: 'load probe' })],
    ['mcp daily_summary', () => mcpCall(person.claudeKey, 'daily_summary', {})],
  ];
}

/** What a person sees (ids for links and writes): shared plus their own, open first. */
export function idsFor(team, person) {
  const mine = team.tasks.filter(x => x.visibility === 'org' || x.ownerId === person.userId);
  const open = mine.filter(x => x.open);
  return {
    tasks: open.slice(0, 200).map(x => x.ref),
    refs: open.slice(0, 50).map(x => x.ref),
    openTasks: open.filter((x, i) => i % 3 === 2).map(x => x.id),
    projects: team.projects.filter(p => p.visibility === 'org' || p.ownerId === person.userId).map(p => p.id),
    // seed.mjs: notes ln150..ln299 belong to projects[i % 50] and are placed like it.
    notes: Array.from({ length: 150 }, (_, k) => 150 + k).filter(i => { const p = team.projects[i % team.projects.length]; return p.visibility === 'org' || p.ownerId === person.userId; }).map(i => 'ln' + i),
  };
}

/**
 * Measures each kind `reps` times; returns rows { name, ops, docsExamined, keysExamined, nreturned, collscans,
 * clientKB, sentKB, cpuMs, ms } (averages per request; sentKB and cpuMs only with the meter).
 */
export async function runProbe({ team, person, reps = 10, only = null, log = console.log }) {
  await profilerOn(200);
  const cookie = await cookieFor(person.email, team.password);
  const b = new Browser({ cookie, ids: idsFor(team, person), tag: 'probe' });
  const list = kinds(b, person, idsFor(team, person)).filter(([name]) => !only || only.includes(name));
  // Warm every kind once (first renders compile and fill caches), then measure.
  for (const [, fn] of list) { await fn(); await sleep(50); }
  await sleep(1500);
  const idle = await idleCpu();
  const rows = [];
  for (const [name, fn] of list) {
    // A batch back to back, then the after() work: CPU and database work per request are the batch's over reps.
    const write = /^(action|mcp update)/.test(name);
    const n = write ? Math.max(3, Math.ceil(reps / 2)) : reps;
    await sleep(300);
    const m0 = await meter();
    const t0 = new Date();
    let ms = 0;
    let kb = 0;
    const statuses = new Set(); // answers other than 200 (a wrong _rsc or header is answered cheaply and measures nothing)
    for (let i = 0; i < n; i++) {
      b.lastBytes = 0;
      b.lastStatus = 0;
      const s = Date.now();
      await fn();
      if (b.lastStatus && b.lastStatus !== 200) statuses.add(b.lastStatus);
      ms += Date.now() - s;
      kb += b.lastBytes / 1024;
    }
    await sleep(700); // after() work: alert flush, usage log, push fan-out
    const m1 = await meter();
    const t1 = new Date();
    const p = await rawDb.collection('system.profile').find({ ts: { $gte: t0, $lt: t1 }, ns: { $not: /system\.profile|\$cmd$|\.indexes$/ }, op: { $ne: 'getmore' } }).project({ docsExamined: 1, keysExamined: 1, nreturned: 1, planSummary: 1, ns: 1 }).toArray();
    const acc = { ops: p.length, docsExamined: 0, keysExamined: 0, nreturned: 0, collscans: 0, clientKB: kb, sentKB: 0, cpuMs: 0, ms };
    const scans = new Set();
    for (const d of p) {
      acc.docsExamined += d.docsExamined ?? 0;
      acc.keysExamined += d.keysExamined ?? 0;
      acc.nreturned += d.nreturned ?? 0;
      if (/COLLSCAN/.test(d.planSummary ?? '')) { acc.collscans++; scans.add(d.ns.split('.').slice(1).join('.')); }
    }
    if (m0 && m1) {
      acc.cpuMs = Math.max(0, (m1.cpuSec - m0.cpuSec) * 1000 - idle * (m1.wallSec - m0.wallSec));
      acc.sentKB = Object.entries(m1.routes).reduce((a, [k, v]) => a + v.bytes - (m0.routes[k]?.bytes ?? 0), 0) / 1024;
    }
    const r = { name };
    for (const k of Object.keys(acc)) r[k] = +(acc[k] / n).toFixed(1);
    r.scans = [...scans];
    r.statuses = [...statuses];
    rows.push(r);
    log(`PROBE ${name.padEnd(30)} ops=${r.ops} docsEx=${r.docsExamined} keysEx=${r.keysExamined} ret=${r.nreturned} scans=${r.collscans}${r.scans.length ? '(' + r.scans.join(',') + ')' : ''} KB=${r.clientKB} sentKB=${r.sentKB} cpuMs=${r.cpuMs} ms=${r.ms}${r.statuses.length ? ' status=' + r.statuses.join(',') : ''}`);
  }
  return rows;
}

/** The server's CPU per wall second while nothing is asked of it (timers, open streams). */
async function idleCpu() {
  const a = await meter();
  if (!a) return 0;
  await sleep(2000);
  const b = await meter();
  return ((b.cpuSec - a.cpuSec) * 1000) / (b.wallSec - a.wallSec);
}

// CLI: LOAD_SCRIPT=probe.mjs bash tests/load/run.sh
if (process.argv[1] && /probe\.mjs$/.test(process.argv[1])) {
  const { loadTeam } = await import('./team.mjs');
  const team = loadTeam();
  await runProbe({ team, person: team.people[4], reps: Number(process.env.PROBE_REPS || 10) });
  process.exit(0);
}
// Treefor is re-exported for tests of the request shapes.
export { treeFor };
