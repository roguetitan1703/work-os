// A working day of the whole team, compressed (tests/load/README.md). Run through tests/load/run.sh.
//   node sim.mjs [--minutes 16] [--hours 8] [--real 2] [--no-probe]
// - 20 people: --real of them in real Chromium tabs (Playwright, one browser, page clock sped up to the simulation's
//   speed), the rest scripted browsers (clients.mjs Browser) that send what a real tab sends;
// - 20 workers (the real loop and core, stub sessions, simulation clock) on their push streams; 3 people use the
//   dispatcher and give tasks to Claude during the day;
// - every person's Claude making MCP calls;
// then an idle minute (everyone away, pages and workers connected) for the per-hour cost of being connected.
// Measures on the server (meter.cjs, mongod profiler) and prints/writes the report (report.json, report.txt).
import fs from 'node:fs';
import path from 'node:path';
import { B, launch } from '../e2e/lib.mjs';
import { loadTeam } from './team.mjs';
import { cookieFor, startWorker, signInPage, pageOf, PREFETCH } from './clients.mjs';
import { meter, meterReset, profilerOn, profilerOff, profileByRoute, collscans, serverStatus } from './measure.mjs';
import { runProbe } from './probe.mjs';
import { makeDay } from './day.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const MINUTES = arg('minutes', 16);
const HOURS = arg('hours', 8);
const REAL = arg('real', 2);
const IDLE_SEC = arg('idle', 60);
const PROBE = !process.argv.includes('--no-probe');
const SPEED = (HOURS * 3600) / (MINUTES * 60); // sim ms per real ms
const OUT = process.env.LOAD_OUT_DIR;

const team = loadTeam();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const expo = mean => -Math.log(1 - rnd()) * mean;

// ── per-route cost, one at a time (before the day, so nothing else runs) ──
const probe = PROBE ? await runProbe({ team, person: team.people[4], reps: 3 }) : [];

// ── the day ──
let R0 = 0;
let T0 = 0;
const clock = () => T0 + (Date.now() - R0) * SPEED;
const DAY_MS = HOURS * 3600_000;

// Client-side request log: per tag and kind: n, bytes, errors.
const log = {};
const recFor = tag => (kind, url, status, bytes) => {
  const k = `${kind} ${pageOf(url) ?? url}`;
  const t = (log[tag] ??= {});
  const e = (t[k] ??= { n: 0, kb: 0, err: 0 });
  e.n++;
  e.kb += bytes / 1024;
  if (status < 200 || status >= 400) e.err++;
};

const people = team.people;
const realPeople = people.slice(0, REAL);
const scripted = people.slice(REAL);
const cookies = new Map();
for (const p of scripted) cookies.set(p.email, await cookieFor(p.email, team.password));

let browser = null;
const realPages = [];
if (REAL > 0) {
  browser = await launch();
  for (const [i, p] of realPeople.entries()) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, extraHTTPHeaders: { 'x-load-client': 'real' } });
    const page = await ctx.newPage();
    await signInPage(page, p.email, team.password);
    const n = {};
    page.on('request', r => {
      const u = new URL(r.url());
      if (u.origin !== B || u.pathname.startsWith('/_next/') || /\.(js|css|png|svg|ico|webmanifest|woff2?)$/.test(u.pathname)) return;
      const h = r.headers();
      const kind = h['next-action'] ? 'action' : h['next-router-prefetch'] ? (h['next-router-segment-prefetch'] ? 'prefetch-tree' : 'prefetch') : h.rsc ? 'rsc' : u.pathname.startsWith('/api/') ? 'api' : 'page';
      const k = `${kind} ${pageOf(u.pathname + u.search) ?? u.pathname}`;
      n[k] = (n[k] ?? 0) + 1;
    });
    realPages.push({ person: p, ctx, page, n, role: i === 0 ? 'claude-open' : 'working' });
  }
}

const workers = [];
const stopFlags = { stop: false };

await meterReset();
const status0 = await serverStatus();
await profilerOn(600);
const prof0 = new Date();
R0 = Date.now();
T0 = Date.now();
console.log(`day: ${HOURS} h in ${MINUTES} min (x${SPEED.toFixed(0)}), ${scripted.length} scripted + ${realPages.length} real browsers, ${people.length} workers`);

// Workers: every person's computer.
for (const p of people) workers.push(startWorker({ person: p, clock, speed: SPEED, allowPrompts: !!p.dispatcher, activityEvery: 2 * 3600_000 }));

/** Real tabs: the page clock runs at the simulation's speed. */
async function realDay(rp) {
  const { page } = rp;
  await page.clock.install();
  await page.goto(B + (rp.role === 'claude-open' ? '/claude' : '/today'));
  const tick = 250;
  let next = rp.role === 'working' ? clock() + 3 * 60_000 : Infinity;
  const steps = ['aside a[href="/tasks"]', 'aside a[href="/today"]', 'main a[href^="/projects/"]:visible', 'aside a[href="/today"]', 'COMPLETE', 'aside a[href="/projects"]'];
  let s = 0;
  while (!stopFlags.stop && clock() - T0 < DAY_MS) {
    await page.clock.runFor(tick * SPEED).catch(() => {});
    await sleep(tick);
    if (clock() >= next) {
      next = clock() + expo(4 * 60_000);
      const step = steps[s++ % steps.length];
      try {
        await page.mouse.move(200 + (s % 5) * 20, 300);
        if (step === 'COMPLETE') await page.locator('[data-variant=desk] button[title="Mark done"]').first().click({ timeout: 3000 });
        else await page.click(step, { timeout: 3000 });
      } catch { /* a missing link is skipped */ }
    }
  }
}

const day = makeDay({ team, clock, speed: SPEED, t0: T0, dayMs: DAY_MS, stop: stopFlags, rec: recFor, rnd });
const days = [...scripted.map((p, i) => day.personDay(p, i, cookies.get(p.email))), ...people.map(p => day.claudeDay(p)), ...realPages.map(realDay)];
let meterFails = 0;
const progress = setInterval(async () => {
  const m = await meter().catch(() => null);
  if (!m && ++meterFails >= 2) {
    console.log('the server stopped answering (it exited or was killed); see server.log. Aborting.');
    process.exit(3);
  }
  if (m) meterFails = 0;
  if (m) console.log(`  t=${((clock() - T0) / 3600_000).toFixed(1)} h  cpu=${m.cpuSec.toFixed(0)} s  rss=${m.memMB.rssNow} MB  streams=${JSON.stringify(m.streams.open)}  loop p99=${m.eventLoopMs.p99} ms`);
}, 60_000);
const results = await Promise.allSettled(days);
clearInterval(progress);
const failed = results.filter(r => r.status === 'rejected');
if (failed.length) console.log(`${failed.length} clients failed: ${failed.slice(0, 3).map(f => f.reason?.message).join(' | ')}`);
const browsers = results.slice(0, scripted.length).map(r => r.value).filter(Boolean);
const dayStats = await meter();
const status1 = await serverStatus();
const byRoute = await profileByRoute(prof0);
const scans = await collscans(prof0);

// ── an idle stretch: everyone away, Claude pages and workers stay connected ──
// The watchers' tabs stay on /claude with their streams. Workers start again on the real clock (on the simulation
// clock their 5-minute fallback poll would come every few seconds).
stopFlags.stop = true;
for (const w of workers) w.stop();
const idleWorkers = people.map(p => startWorker({ person: p, clock: () => Date.now(), speed: 1, allowPrompts: !!p.dispatcher }));
await sleep(15_000);
await meterReset();
await sleep(IDLE_SEC * 1000);
const idleStats = await meter();
for (const w of idleWorkers) w.stop();
for (const b of browsers) b.closeStream();
await profilerOff();
const realCounts = realPages.map(rp => ({ role: rp.role, requests: rp.n }));
if (browser) await browser.close();

// ── report ──
const userHours = people.length * HOURS;
const sum = (o, f = x => x) => Object.values(o).reduce((a, x) => a + f(x), 0);
const meterReq = sum(dayStats.routes, r => r.n) - (dayStats.routes.static?.n ?? 0);
const idleCpuPerHour = ((idleStats.cpuSec / idleStats.wallSec) * 3600);
// Time-based costs (pings, the idle part of workers) ran for MINUTES real minutes, not HOURS: count them per real hour.
const dayCpuNet = dayStats.cpuSec - (idleStats.cpuSec / idleStats.wallSec) * dayStats.wallSec;
const cpuPerUserHour = Math.max(0, dayCpuNet) / userHours;
const T3_FACTOR = 1.5; // a t3.small vCPU against this PC's core (assumption; docs/cpu.md)
const busyHourCpu = (cpuPerUserHour * people.length + idleCpuPerHour) * T3_FACTOR;
const baselinePerHour = 0.2 * 2 * 3600; // t3.small earns 24 credits an hour = 0.4 vCPU = 1440 CPU-seconds an hour
const dayCpu = busyHourCpu * HOURS + idleCpuPerHour * T3_FACTOR * (24 - HOURS);
const report = {
  at: new Date().toISOString(), minutes: MINUTES, hours: HOURS, speed: +SPEED.toFixed(1), people: people.length, realBrowsers: realPages.length, prefetch: PREFETCH, done: day.done,
  server: { cpuSec: +dayStats.cpuSec.toFixed(1), wallSec: +dayStats.wallSec.toFixed(0), mem: dayStats.memMB, eventLoopMs: dayStats.eventLoopMs, gc: dayStats.gc, streamsPeak: dayStats.streams.peak, requests: meterReq },
  idle: { cpuPerHourSec: +idleCpuPerHour.toFixed(1), streamsOpen: idleStats.streams.open, requestsPerHour: Math.round((sum(idleStats.routes, r => r.n) / idleStats.wallSec) * 3600) },
  perUserHour: {
    cpuSec: +cpuPerUserHour.toFixed(2),
    requests: +(meterReq / userHours).toFixed(1),
    sentKB: +(sum(dayStats.routes, r => r.bytes) / 1024 / userHours).toFixed(0),
    dbOps: +(sum(byRoute, r => r.ops) / userHours).toFixed(0),
    docsExamined: +(sum(byRoute, r => r.docsExamined) / userHours).toFixed(0),
  },
  t3small: { assumedSlowerBy: T3_FACTOR, busyHourCpuSec: Math.round(busyHourCpu), busyHourVcpu: +(busyHourCpu / 3600).toFixed(3), baselineCpuSecPerHour: baselinePerHour, dayCpuSec: Math.round(dayCpu), dayBaselineCpuSec: baselinePerHour * 24, dayShareOfBaseline: +(dayCpu / (baselinePerHour * 24)).toFixed(2), usersAtBaseline: Math.floor(((baselinePerHour * 24) / T3_FACTOR - idleCpuPerHour * 24) / (cpuPerUserHour * HOURS)) },
  mongod: { docsExamined: status1.scannedObjects - status0.scannedObjects, keysExamined: status1.scanned - status0.scanned, returned: status1.returned - status0.returned, queries: status1.opcounters.query - status0.opcounters.query, commands: status1.opcounters.command - status0.opcounters.command },
  routes: Object.fromEntries(Object.entries(dayStats.routes).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, { n: v.n, perUserHour: +(v.n / userHours).toFixed(2), sentKB: Math.round(v.bytes / 1024), avgMs: +(v.ms / Math.max(1, v.n)).toFixed(1), maxMs: Math.round(v.msMax), db: byRoute[k] ?? null }])),
  clients: log, realTabs: realCounts, collscans: scans, probe,
  hints: browsers.reduce((a, b) => a + b.hints, 0), refreshes: browsers.reduce((a, b) => a + b.refreshes, 0),
  workers: { started: workers.reduce((a, w) => a + w.counts.started, 0) },
};

const lines = [];
const P = s => lines.push(s);
P(`Work OS load simulation, ${report.at}`);
P(`links prefetch: ${PREFETCH}; done: ${JSON.stringify(day.done)}`);
P(`${people.length} people, a ${HOURS} h day in ${MINUTES} min (x${report.speed}); ${realPages.length} real Chromium tabs, ${scripted.length} scripted browsers, ${people.length} workers, ${people.length} Claude (MCP) users`);
P('');
P(`Server (next start, heap cap ${process.env.LOAD_HEAP_MB || 1024} MB): CPU ${report.server.cpuSec} s over ${report.server.wallSec} s; RSS peak ${dayStats.memMB.rssPeak} MB, avg ${dayStats.memMB.rssAvg} MB; heap peak ${dayStats.memMB.heapPeak} MB; event loop p50 ${dayStats.eventLoopMs.p50} ms, p99 ${dayStats.eventLoopMs.p99} ms, max ${dayStats.eventLoopMs.max} ms; GC ${dayStats.gc.ms} ms`);
P(`Streams peak: ${JSON.stringify(dayStats.streams.peak)}; requests ${meterReq}`);
P(`Idle (everyone away, connected): ${report.idle.cpuPerHourSec} CPU s per hour, ${report.idle.requestsPerHour} requests per hour, streams ${JSON.stringify(report.idle.streamsOpen)}`);
P('');
P(`Per user-hour: CPU ${report.perUserHour.cpuSec} s, ${report.perUserHour.requests} requests, ${report.perUserHour.sentKB} KB sent, ${report.perUserHour.dbOps} DB ops, ${report.perUserHour.docsExamined} docs examined`);
P(`t3.small (vCPU assumed ${T3_FACTOR}x slower than this PC): busy hour ${report.t3small.busyHourCpuSec} CPU s = ${report.t3small.busyHourVcpu} vCPU (baseline ${baselinePerHour} CPU s = 0.4 vCPU); a day ${report.t3small.dayCpuSec} CPU s = ${Math.round(report.t3small.dayShareOfBaseline * 100)}% of the daily baseline; people at the baseline: ${report.t3small.usersAtBaseline}`);
P('');
P('Requests by route (day): n, per user-hour, KB sent, avg ms, DB ops / docs examined / collection scans');
for (const [k, v] of Object.entries(report.routes).slice(0, 40)) P(`  ${k.padEnd(36)} ${String(v.n).padStart(6)} ${String(v.perUserHour).padStart(7)} ${String(v.sentKB).padStart(7)} KB ${String(v.avgMs).padStart(6)} ms   ${v.db ? `${v.db.ops} / ${v.db.docsExamined} / ${v.db.collscans}` : ''}`);
P('');
P(`Claude-page hints received ${report.hints}, refreshes ${report.refreshes}; dispatcher sessions started ${report.workers.started}`);
P('Collection scans (by collection and filter):');
for (const s of scans.slice(0, 12)) P(`  ${s._id.coll} ${JSON.stringify(s._id.keys)}: ${s.n} scans, ${s.docs} docs (${s.routes.slice(0, 3).join(', ')})`);
P('Real tabs: ' + JSON.stringify(realCounts));
const text = lines.join('\n');
console.log(text);
if (OUT) {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.txt'), text + '\n');
}
process.exit(0);
