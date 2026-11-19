// The idle session's wait (Stop and SessionStart, asyncRewake: Claude Code keeps it running after the turn ended and wakes the
// idle session when it exits 2 and prints on stderr). It asks POST /api/agent/wait with the session token, which holds the call
// up to 50 s. Answers: `wake` (a message that may wake the session, or an answer to a Need it asked: handed over as read, framed by
// the server) -> the text on stderr, exit 2; `busy` -> the session is working, so in-turn delivery has it: stop; `again` -> ask
// again. One waiter per session: a new one takes the lock file (<hooks>/sessions/<id>.wait) and the old one stops at its next
// look (the server also ends the older call). It never wakes a session whose marker says working, ends 2 minutes before the hook's
// timeout (no heartbeat: after that a message waits for the next turn), backs off 30 s up to 5 min on an error or the hourly
// limit, and never prints the token. No token (no worker sign-in, a cloud session): nothing to wait for.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS, HERE, MAX_BRIEF, postAgent, readKept, readMarker, run, writeMarker } from './hook-lib.mjs';

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
export async function wait(input) {
  const sid = input.session_id;
  if (!sid || input.agent_id) return null;
  const token = readKept(sid);
  if (!token) return null;
  const row = EVENTS.find((e) => e.event === 'wait');
  const end = clock.now() + ((row?.timeoutS ?? 3600) - LEAVE_S) * 1000;
  const lock = takeLock(sid);
  let backoff = clock.backoffStart;
  let settle = 0;
  try {
    for (;;) {
      if (!holds(sid, lock)) return null; // a newer waiter took over
      if (clock.now() + POLL_TIMEOUT_MS > end) return null;
      if (working(sid)) {
        if (++settle > SETTLE_TRIES) return null; // a turn is running: delivery inside it has the messages
        await clock.sleep(SETTLE_MS);
        continue;
      }
      let r = null;
      try { r = await postAgent('/api/agent/wait', token, {}, POLL_TIMEOUT_MS); } catch { r = null; }
      if (!holds(sid, lock)) return null;
      if (r?.status === 200 && r.b) {
        backoff = clock.backoffStart;
        if (r.b.wake === true && typeof r.b.text === 'string' && r.b.text) {
          if (working(sid)) return null; // a turn began while the call was open: the text was handed over and is in the inbox
          const m = readMarker(sid);
          if (m) writeMarker(sid, { ...m, wokeAt: clock.now() });
          run.stderr = r.b.text.slice(0, MAX_BRIEF);
          run.exitCode = 2;
          return null;
        }
        if (r.b.busy === true) {
          if (++settle > SETTLE_TRIES) return null;
          await clock.sleep(SETTLE_MS);
          continue;
        }
        settle = 0; // again: ask again
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
