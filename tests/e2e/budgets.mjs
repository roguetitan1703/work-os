// Cost budgets (tests/load/budgets.json, docs/cpu.md "Multi-user"): a short version of the load simulation that fails
// the build when a change makes a request, a page, an idle tab or an idle worker cost more than its budget.
// Seeds the load team (20 people, 50 projects, 2,000 tasks; tests/load/seed.mjs), then:
//   1. per request kind, one at a time: database operations, documents examined, collection scans, response KB
//      (tests/load/probe.mjs; profiler on the throwaway mongod);
//   2. a real Chromium session: requests per step (tests/load/session.mjs);
//   3. an hour of an idle Claude page and Today page (page clock) and an idle worker (simulated clock);
//   4. a minute of the whole team at once (scripted browsers and Claude, tests/load/day.mjs): requests and documents
//      examined per user-hour.
// Each over-budget number is one FAIL line: "budget <where> <metric>: <actual> > <budget>".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, finish, launch, rawDb } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOAD = path.join(HERE, '../load');
const budgets = JSON.parse(fs.readFileSync(path.join(LOAD, 'budgets.json'), 'utf8'));
const results = {};
const over = (where, metric, actual) => {
  const b = budgets[where.split(' :: ')[0]]?.[where.split(' :: ')[1]]?.[metric];
  if (b === undefined) return;
  (results[where] ??= {})[metric] = actual;
  check(`budget ${where.split(' :: ')[1]} ${metric}: ${actual} <= ${b}`, actual <= b, `${where.split(' :: ')[1]} ${metric} is ${actual}, budget ${b}`);
};

try {
  execFileSync(process.execPath, ['seed.mjs'], { cwd: LOAD, stdio: 'inherit' });
  const { loadTeam } = await import('../load/team.mjs');
  const team = loadTeam();

  // 1. per request kind
  const { runProbe } = await import('../load/probe.mjs');
  const { profilerOff } = await import('../load/measure.mjs');
  const rows = await runProbe({ team, person: team.people[4], reps: 4 }).finally(() => profilerOff({ drop: true }));
  for (const r of rows) {
    check(`probe ${r.name}: answered 200 (else it measured nothing)`, !r.statuses.length, `status ${r.statuses.join(',')}`);
    over(`routes :: ${r.name}`, 'kb', r.clientKB);
    over(`routes :: ${r.name}`, 'ops', r.ops);
    over(`routes :: ${r.name}`, 'docsExamined', r.docsExamined);
    over(`routes :: ${r.name}`, 'collscans', r.collscans);
  }
  for (const name of Object.keys(budgets.routes)) check(`budget route measured: ${name}`, rows.some(r => r.name === name));

  // 2. a real session, requests per step
  const browser = await launch();
  try {
    const { browserSession } = await import('../load/session.mjs');
    const { steps } = await browserSession({ browser, team, person: team.people[5], teammate: team.people[0], wait: 4000 });
    for (const [s, kinds] of Object.entries(steps)) over(`session :: ${s}`, 'requests', kinds.total);
    for (const name of Object.keys(budgets.session)) check(`budget step ran: ${name}`, !!steps[name]);

    // 3. idle for an hour
    const { idlePageHour, idleWorkerHour } = await import('../load/idle.mjs');
    over('perHour :: idle Claude page, untouched', 'requests', (await idlePageHour({ browser, team, person: team.people[6], path: '/claude', inUse: false })).total);
    over('perHour :: idle Claude page, in use', 'requests', (await idlePageHour({ browser, team, person: team.people[6], path: '/claude', inUse: true })).total);
    over('perHour :: idle Today page, in use', 'requests', (await idlePageHour({ browser, team, person: team.people[7], path: '/today', inUse: true })).total);
    const w = await idleWorkerHour({ person: team.people[8] });
    check('idle worker: push stream was up', w.pushUp);
    over('perHour :: idle worker', 'requests', w.total);
  } finally {
    await browser.close();
  }

  // 4. the whole team for a minute (half an hour of their day at x30)
  const { cookieFor } = await import('../load/clients.mjs');
  const { makeDay } = await import('../load/day.mjs');
  const SPEED = 30;
  const R0 = Date.now();
  const clock = () => R0 + (Date.now() - R0) * SPEED;
  const n = { scripted: 0, mcp: 0 };
  const rec = tag => () => { n[tag] = (n[tag] ?? 0) + 1; };
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const stop = { stop: false };
  const day = makeDay({ team, clock, speed: SPEED, t0: R0, dayMs: 30 * 60_000, stop, rec, rnd });
  const people = team.people.slice(2);
  const cookies = await Promise.all(people.map(p => cookieFor(p.email, team.password)));
  const st = async () => (await rawDb.admin().command({ serverStatus: 1 })).metrics.queryExecutor.scannedObjects;
  const s0 = await st();
  const runs = [...people.map((p, i) => day.personDay(p, i, cookies[i], { lunch: false, startWithin: 2 * 60_000 })), ...people.map(p => day.claudeDay(p, { startWithin: 2 * 60_000 }))];
  const done = await Promise.allSettled(runs);
  for (const d of done) if (d.status === 'fulfilled' && d.value?.closeStream) d.value.closeStream();
  const docs = (await st()) - s0;
  // Normalised per thing done (a slow server finishes fewer things in the minute), at 15 things an hour.
  const things = Math.max(1, day.done.things);
  console.log(`team minute: ${day.done.things} things, ${day.done.writes} writes, ${day.done.mcp} MCP calls, ${n.scripted} browser requests, ${docs} documents examined`);
  over('perUserHour :: active person (browser)', 'requests', Math.round((n.scripted / things) * 15));
  over('perUserHour :: active person (browser and Claude)', 'docsExamined', Math.round((docs / things) * 15));
} catch (e) {
  check('budgets suite ran to the end', false, e.stack ?? String(e));
}
await rawDb.command({ profile: 0 }).catch(() => {});
await rawDb.collection('system.profile').drop().catch(() => {});
const out = process.env.E2E_LOGS;
if (out) fs.writeFileSync(path.join(out, 'budgets.json'), JSON.stringify(results, null, 1));
await finish();
