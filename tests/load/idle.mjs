// Requests per hour of something left open (tests/load/README.md), against the real server on a simulated clock:
//   idlePageHour     a real Chromium tab on a page for an hour (Playwright's page clock), untouched or in use (input
//                    every 30 s), with its push stream as it is;
//   idleWorkerHour   the real worker loop and core for an hour on a simulated clock, with its real push stream up.
// Used by the budgets suite; docs/cpu.md has the numbers.
import { B } from '../e2e/lib.mjs';
import { signInPage } from './clients.mjs';
import { createCore } from '../../worker/core.mjs';
import { createLoop } from '../../worker/loop.mjs';
import { makeApi } from '../../worker/api.mjs';
import { connectPush } from '../../worker/push.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** { page, prefetch, action, stream, other, total } requests in one simulated hour on `path`. */
export async function idlePageHour({ browser, team, person, path, inUse }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const p = await ctx.newPage();
  await signInPage(p, person.email, team.password);
  await p.clock.install();
  await p.goto(B + path);
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(1500);
  const n = { page: 0, prefetch: 0, action: 0, stream: 0, other: 0, total: 0 };
  p.on('request', r => {
    const u = new URL(r.url());
    if (u.origin !== B || u.pathname.startsWith('/_next/') || u.pathname.startsWith('/icons')) return;
    const h = r.headers();
    const k = u.pathname === '/api/stream' ? 'stream' : h['next-action'] ? 'action' : h['next-router-prefetch'] ? 'prefetch' : h.rsc || u.searchParams.has('_rsc') ? 'page' : 'other';
    n[k]++;
    n.total++;
  });
  for (let i = 0; i < 120; i++) {
    if (inUse) await p.mouse.move(100 + (i % 7) * 10, 200);
    await p.clock.runFor(30_000);
    await sleep(40);
  }
  await sleep(1500);
  await ctx.close();
  return n;
}

/** { jobs, status, folders, total } requests of an idle worker in one simulated hour, its push stream up. */
export async function idleWorkerHour({ person }) {
  let t = 1_000_000_000;
  const calls = { jobs: 0, status: 0, folders: 0 };
  const cfg = { baseUrl: B, roots: [], scanEveryMinutes: 24 * 60, enabled: true, allowPrompts: false };
  const real = makeApi(() => cfg, () => person.deviceKey);
  const api = {
    getJobs: () => (calls.jobs++, real.getJobs()),
    postStatus: b => (calls.status++, real.postStatus(b)),
    postFolders: f => (calls.folders++, real.postFolders(f)),
  };
  const push = connectPush({ getCfg: () => cfg, getToken: () => person.deviceKey, onWake: () => {} });
  for (let i = 0; i < 50 && !push.up; i++) await sleep(100);
  const up = push.up;
  const state = { ids: {}, folders: {}, sessions: {}, markers: {}, lastScan: t };
  const activity = async () => ({ counts: { sessions: 1, sessionsWorkOs: 0, sessionsOther: 1, sessionsActive: 0, subagents: 0 }, list: [] });
  const core = createCore({ getConfig: () => cfg, state, save: () => {}, api, now: () => t, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, activity });
  const loop = createLoop({ core, getConfig: () => cfg, state, now: () => t, pushUp: () => push.up });
  const end = t + 3600_000;
  while (t < end) t += Math.max(await loop.step(), 1);
  push.stop();
  return { ...calls, total: calls.jobs + calls.status + calls.folders, pushUp: up };
}
