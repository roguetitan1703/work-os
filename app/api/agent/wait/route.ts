import { z } from 'zod';
import { projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf, readCapped } from '@/lib/agent-auth';
import { reserveAgent } from '@/lib/mcp/policy';
import { applyAck, deliverFor, sessionRow, wakeWaiting, wakesLeft } from '@/lib/data/deliver';
import { presenceState } from '@/lib/data/presence-state';
import { touchPresence } from '@/lib/data/presence';
import { waitFor } from '@/lib/live';

// The idle session's long poll (docs/flows/agent-system.md section 11; plan note 6dfdb98f4f). The Work OS hook that Claude Code
// keeps running after a turn ends (worker/hook-wait.mjs, asyncRewake) asks here; an answer of `wake` makes it exit 2 with the
// text, which wakes the idle session.
// POST /api/agent/wait, JSON body { since?: string } (nothing else; the body is at most 1 KB).
//   Authorization: Bearer wst_…  the session token from /api/agent/start, for its own session only. Nothing else opens it:
//                                no device key, no Work OS API key, no OAuth token, no session cookie, no X-API-Key.
//                                The token's owner must still be a member of its organization, and the project must still have
//                                a folder on the token's computer, on every call.
//   Holds up to WAIT_MS (nginx's /api read timeout is 120 s) until something may wake the session, then answers:
//     200 { wake: true, text }   a request, question or decision addressed to the session (never an fyi, never an untargeted
//                                project message, never a message at chain 2 or more), or an answer to a Need it asked: handed
//                                over as read (lib/data/deliver.ts), framed, the session's wokeAt set. At most 6 an hour.
//     (every call and every wait round also refreshes the row's lastSeen, at most once a minute: Identity step 2)
//     200 { busy: true }         the session is working (or off): in-turn delivery has it; the hook stops waiting
//     200 { again: true }        nothing: ask again (a newer waiter for the session, or the time is up); with retryAfter (and a
//                                Retry-After header) when too many sessions are waiting: ask again no sooner than that
//   body { since?, ack? }: ack = ids the hook printed from the last offer (see the event route); applied first.
//   401 no or bad credential · 404 no such session or no folder on this computer any more · 400 bad body · 413 too large
//   429 over the hourly limit of 120 polls (Retry-After)
// Several messages that come close together go out as one wake (WAKE_BATCH_MS). The wait is in this process (lib/live.ts); the
// database is read again at the end of each wait, so another instance would only slow a wake to one poll.
// proxy.ts lets this exact path through untouched: this route checks its own credential. Logs: the status only.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1024;
const WAIT_MS = 50_000;
const WAKE_BATCH_MS = 3_000;

const Body = z.object({ since: z.string().max(40).optional(), ack: z.array(z.string().max(40)).max(12).optional() }).strict();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await authAgentToken(bearerOf(req));
    if (!auth) return unauthorized();
    const { s, device, session } = auth;
    if (!(await reserveAgent('wait', session.id))) {
      return reply(429, { error: 'Too many Work OS waits from this session in the last hour; try again later.' }, { 'Retry-After': '600' });
    }
    const text = await readCapped(req, MAX_BODY);
    if (text === null) return reply(413, { error: 'body too large' });
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        return reply(400, { error: 'The body is not JSON.' });
      }
    }
    const body = Body.safeParse(raw);
    if (!body.success) return reply(400, { error: 'The body may have a since and an ack and nothing else.' });

    const sid = session.id;
    const projectId = session.projectId;
    // Checked on every call (and again after each wait): the folder may have been unlinked since the session began.
    if (projectId && !(await projectOnDevice(s, device.id, projectId))) return reply(404, { error: 'This project has no folder on this computer any more.' });
    if (body.data.ack?.length) await applyAck(s, sid, projectId, body.data.ack);
    const key = `${s.userId}:${sid}`;
    const end = Date.now() + WAIT_MS;
    let batched = false;
    for (;;) {
      const row = await sessionRow(s, sid, projectId);
      if (!row) return reply(404, { error: 'not found' });
      // A session waiting here is alive: its row is refreshed once a minute, so a quiet idle session is not taken for a gone one (lib/data/presence-state.ts).
      await touchPresence(s, row);
      const seenNow = Date.now(); // the touch above wrote this (or the row was fresher): it is alive
      // A row the hook has not reported on yet (no activity) is idle: the call-based rules of the roster would call it working.
      const st = row.activity || row.endedAt ? presenceState({ lastSeen: new Date(Math.max(row.lastSeen.getTime(), seenNow)), activity: row.activity, endedAt: row.endedAt }, { now: Date.now() }) : { state: 'on' as const, why: undefined };
      // Mid-turn (working, or stopped at a permission prompt) or gone: the hook stops waiting and delivery inside the turn has it.
      if (st.state === 'working' || st.state === 'off' || (st.state === 'waiting' && st.why === 'prompt')) return reply(200, { busy: true });
      if (projectId && (await wakesLeft(sid)) > 0 && (await wakeWaiting(s, sid, projectId))) {
        // What came together goes out together: look again after a short pause, then hand it all over once.
        if (!batched && end - Date.now() >= 8_000) {
          batched = true;
          await sleep(WAKE_BATCH_MS);
          continue;
        }
        // The hook has gone (its call timed out): nothing is offered to nobody.
        if (req.signal.aborted) return reply(200, { again: true });
        const r = await deliverFor(s, sid, projectId, 'wake');
        if (r.delivery) return reply(200, { wake: true, text: r.delivery.text, ack: [...r.delivery.ids, ...r.delivery.needs] });
      }
      const left = end - Date.now();
      if (left <= 0) return reply(200, { again: true });
      const how = await waitFor(s.orgId, key, left);
      if (how === 'bumped') return reply(200, { again: true });
      // Too many waiters (this person's or all): not held; the hook waits at least this long before asking again.
      if (how === 'refused') return reply(200, { again: true, retryAfter: 60 }, { 'Retry-After': '60' });
      if (projectId && !(await projectOnDevice(s, device.id, projectId))) return reply(404, { error: 'This project has no folder on this computer any more.' });
    }
  } catch (err) {
    console.error('[agent/wait]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
