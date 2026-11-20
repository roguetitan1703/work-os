// The idle session's wait (Stop and SessionStart, asyncRewake: Claude Code keeps it running after the turn ended and wakes the
// idle session when it exits 2 and prints on stderr). It asks POST /api/agent/wait with the session token, which holds the call
// up to 50 s. Answers: `wake` (a message that may wake the session, or an answer to a Need it asked: handed over as read, framed by
// the server) -> the text on stderr, exit 2; `busy` -> the session is working, so in-turn delivery has it: stop; `again` -> ask
// again. One waiter per session: a new one takes the lock file (<hooks>/sessions/<id>.wait) and the old one stops at its next
// look (the server also ends the older call). It never wakes a session whose marker says working, ends 2 minutes before the hook's
// timeout (no heartbeat: after that a message waits for the next turn), backs off 30 s up to 5 min on an error or the hourly
// limit, and never prints the token. No token (no worker sign-in, a cloud session): nothing to wait for.
// It waits only while the Claude Code process that started it lives (hook-gate.mjs parentGone: found once, then checked before every
// poll and every 2 s while a poll is open). Gone: the open poll is cancelled (the server offers nothing to a cancelled call) and the
// wait ends with exit 0, so no message is taken for a dead session. A subagent's Stop and a `claude -p` or SDK run never get here
// (hook-gate.mjs RULES), so such a run can exit.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS, HERE, MAX_BRIEF, postAgent, readKept, readMarker, run, updateMarker } from './hook-lib.mjs';
import { gate, parent } from './hook-gate.mjs';

export { parent }; // what tests replace

const POLL_TIMEOUT_MS = 55_000; // the server holds a poll 50 s
const LEAVE_S = 120;
const SETTLE_TRIES = 6; // a turn that just ended may still say working for a moment (the stop hook posts in parallel)
const SETTLE_MS = 2_000;
/** What tests replace to run fast. */
export const clock = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), backoffStart: 30_000, backoffMax: 300_000 };

const lockFile = (sid) => path.join(HERE, 'sessions', String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.wait');
function takeLock(sid) {
  const id = randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(lockFile(sid)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockFile(sid), JSON.stringify({ id, pid: process.pid, at: Date.now() }), { mode: 0o600 });
  return id;
}
const holds = (sid, id) => { try { return JSON.parse(fs.readFileSync(lockFile(sid), 'utf8')).id === id; } catch { return false; } };
const dropLock = (sid, id) => { try { if (holds(sid, id)) fs.rmSync(lockFile(sid), { force: true }); } catch {} };
const working = (sid) => readMarker(sid)?.presence?.state === 'working';

/** The wait: returns nothing; a wake sets run.exitCode = 2 and run.stderr. */
export async function wait(input, g = gate('wait', input)) {
  const sid = input.session_id;
  if (!sid || !g.run) return null;
  const token = readKept(sid);
  if (!token) return null;
  // No parent process found (an unknown shell, node-run claude on macOS): no wait at all. A waiter that cannot tell when its
  // session died would keep the dead session's row alive and could take a wake for it (hooks review M8).
  if (!g.hasParent()) return null;
  const gone = g.parentGone;
  const row = EVENTS.find((e) => e.event === 'wait');
  const end = clock.now() + ((row?.timeoutS ?? 3600) - LEAVE_S) * 1000;
  const lock = takeLock(sid);
  let backoff = clock.backoffStart;
  let settle = 0;
  // After a few busy answers in a row the waiter does not give up (a busy answer can be wrong: a slow stop hook, a background
  // subagent): it keeps the lock and asks again less often, 30 s doubling to 5 minutes, while the parent lives (hooks review H3).
  let busyBackoff = clock.backoffStart;
  const settleOrBackOff = async () => {
    if (++settle <= SETTLE_TRIES) return clock.sleep(SETTLE_MS);
    await clock.sleep(Math.min(busyBackoff, Math.max(0, end - clock.now())));
    busyBackoff = Math.min(busyBackoff * 2, clock.backoffMax);
  };
  try {
    for (;;) {
      if (!holds(sid, lock)) return null; // a newer waiter took over
      if (gone()) return null; // the session's Claude Code process ended: nobody to wake, take nothing
      if (clock.now() + POLL_TIMEOUT_MS > end) return null;
      if (working(sid)) {
        await settleOrBackOff(); // a turn is running (delivery inside it has the messages) or the marker is behind
        continue;
      }
      let r = null;
      const ack = readMarker(sid)?.ack;
      const sent = Array.isArray(ack) && ack.length ? ack.slice(0, 12) : null;
      const stop = new AbortController();
      const watch = setInterval(() => { if (gone()) stop.abort(); }, parent.everyMs);
      watch?.unref?.();
      try { r = await postAgent('/api/agent/wait', token, sent ? { ack: sent } : {}, POLL_TIMEOUT_MS, stop.signal); } catch { r = null; } finally { if (watch) clearInterval(watch); }
      if (stop.signal.aborted || gone()) return null; // it ended while the poll was open: a wake that still came is not printed
      if (sent && r?.status === 200) updateMarker(sid, (k) => { const left = Array.isArray(k.ack) ? k.ack.filter((id) => !sent.includes(id)) : []; if (left.length) k.ack = left; else delete k.ack; return k; });
      if (!holds(sid, lock)) return null;
      if (r?.status === 200 && r.b) {
        backoff = clock.backoffStart;
        if (r.b.wake === true && typeof r.b.text === 'string' && r.b.text) {
          if (working(sid)) return null; // a turn began while the call was open: the text was handed over and is in the inbox
          const ids = Array.isArray(r.b.ack) ? r.b.ack.filter((i) => typeof i === 'string').slice(0, 12) : [];
          updateMarker(sid, (m) => ({ ...m, wokeAt: clock.now(), ...(ids.length ? { ack: ids } : {}) }));
          run.stderr = r.b.text.slice(0, MAX_BRIEF);
          run.exitCode = 2;
          return null;
        }
        if (r.b.busy === true) {
          await settleOrBackOff();
          continue;
        }
        settle = 0;
        busyBackoff = clock.backoffStart; // again: ask again (not sooner than the server says when it has too many waiters)
        if (typeof r.b.retryAfter === 'number' && r.b.retryAfter > 0) await clock.sleep(Math.min(r.b.retryAfter, 300) * 1000);
        continue;
      }
      if (r && r.status >= 400 && r.status < 500 && r.status !== 429) return null; // refused (token, folder, session gone): nothing to wait for
      await clock.sleep(Math.min(backoff, Math.max(0, end - clock.now())));
      backoff = Math.min(backoff * 2, clock.backoffMax);
    }
  } finally {
    dropLock(sid, lock);
  }
}

export const handle = wait;
