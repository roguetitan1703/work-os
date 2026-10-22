import { STATUS_EVERY_MS } from './core.mjs';

// The worker's main loop (worker.mjs run): scan now and then, poll for jobs, send status.
// Push (push.mjs): a wake from the server, or the stream coming up or going down, ends the current wait and polls
// now. While the stream is up the poll is only a fallback, every FALLBACK_POLL_SECONDS; while it is down the worker
// polls as before (the server's pollSeconds: 30 s idle, 10 s busy).
export const FALLBACK_POLL_SECONDS = 300;

export function createLoop({ core, getConfig, state, log = () => {}, pushUp = () => false, now = () => Date.now() }) {
  let again = false;
  let nextPoll = 0;
  let failing = 0;
  let wakeUp = null;

  const wake = () => {
    again = true;
    if (wakeUp) wakeUp();
  };

  /** One pass. Returns how long to wait before the next one (a wake cuts the wait short). */
  async function step() {
    const cfg = getConfig(); // re-read each cycle so enabled:false takes effect without a restart
    if (cfg.enabled === false) return 30_000;
    try {
      if (!state.lastScan || now() - state.lastScan > cfg.scanEveryMinutes * 60000) await core.scanAndReport();
      if (again || now() >= nextPoll) {
        again = false;
        const r = await core.pollOnce({ statusByTimer: true });
        // Busy (a job open, a session starting): the server asks for 10 s; keep that even with push.
        const delay = pushUp() && r.pollSeconds >= 30 ? FALLBACK_POLL_SECONDS : r.pollSeconds;
        nextPoll = now() + delay * 1000;
      }
      await core.statusTick(pushUp());
      failing = 0;
    } catch (e) {
      failing++;
      nextPoll = now() + Math.min(60, 10 * 2 ** Math.min(failing, 3)) * 1000;
      log(`error: ${String(e.message || e).slice(0, 200)}`); // messages never include the token or remotes
    }
    // Until the next poll or the next status check, whichever is first.
    return again ? 0 : Math.max(0, Math.min(nextPoll - now(), STATUS_EVERY_MS));
  }

  async function run() {
    for (;;) {
      const ms = await step();
      await new Promise((r) => {
        const t = setTimeout(() => { wakeUp = null; r(); }, ms);
        wakeUp = () => { clearTimeout(t); wakeUp = null; r(); };
      });
    }
  }

  return { wake, step, run };
}
