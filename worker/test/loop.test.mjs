import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.mjs';
import { createLoop, FALLBACK_POLL_SECONDS } from '../loop.mjs';

// Requests an idle worker makes in an hour (docs/cpu.md "Push"): the real loop and core against a counting fake API,
// on a simulated clock. Idle = no jobs, no Work OS session, the same Claude sessions on the PC all hour.
function idleHour({ pushUp, jobAt = null }) {
  let t = 1_000_000_000;
  const calls = { jobs: 0, status: 0, folders: 0 };
  let job = null;
  const api = {
    getJobs: async () => { calls.jobs++; const jobs = job ? [job] : []; job = null; return { enabled: true, pollSeconds: 30, links: [], jobs }; },
    postStatus: async () => { calls.status++; return { ok: true }; },
    postFolders: async () => { calls.folders++; return { ok: true }; },
  };
  const state = { ids: {}, folders: {}, sessions: {}, markers: {}, lastScan: t };
  const cfg = { roots: [], scanEveryMinutes: 24 * 60, enabled: true };
  const core = createCore({ getConfig: () => cfg, state, save: () => {}, api, now: () => t, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, activity: async () => ({ counts: { sessions: 1, sessionsWorkOs: 0, sessionsOther: 1, sessionsActive: 0, subagents: 0 }, list: [] }) });
  const loop = createLoop({ core, getConfig: () => cfg, state, now: () => t, pushUp: () => pushUp });
  return (async () => {
    const end = t + 3600_000;
    let woke = null;
    while (t < end) {
      let ms = await loop.step();
      if (jobAt !== null && woke === null && t + ms >= end - 3600_000 + jobAt) {
        // the server pushes a wake at jobAt: the wait ends there and the next pass polls
        ms = Math.max(0, end - 3600_000 + jobAt - t);
        job = { id: 'j_1', kind: 'stop', sessionId: '11111111-2222-4333-8444-555555555555' };
        woke = t + ms;
        t += ms;
        loop.wake();
        continue;
      }
      t += Math.max(ms, 1);
    }
    return { ...calls, total: calls.jobs + calls.status + calls.folders, woke };
  })();
}

test('idle worker, push down: polls every 30 s and sends status about every 2 min, as before', async () => {
  const r = await idleHour({ pushUp: false });
  console.log('idle worker per hour, push down:', JSON.stringify(r));
  assert.ok(r.jobs >= 115 && r.jobs <= 121, `jobs polls ${r.jobs}`);
  assert.ok(r.status >= 28 && r.status <= 34, `status ${r.status}`);
});

test('idle worker, push up: polls only every 5 minutes and sends status only when something changed', async () => {
  const r = await idleHour({ pushUp: true });
  console.log('idle worker per hour, push up:', JSON.stringify(r));
  assert.equal(r.jobs, 3600 / FALLBACK_POLL_SECONDS);
  assert.equal(r.status, 2, 'the first status, then one every STATUS_IDLE_MS (nothing changed)');
});

test('push up: a wake polls at once and the job is handled', async () => {
  const r = await idleHour({ pushUp: true, jobAt: 1_000_000 });
  assert.ok(r.woke !== null);
  assert.equal(r.jobs, 3600 / FALLBACK_POLL_SECONDS + 1, 'one extra poll for the wake');
  assert.ok(r.status >= 2, 'the job result went out');
});
