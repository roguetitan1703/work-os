import { z } from 'zod';
import { projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf, readCapped } from '@/lib/agent-auth';
import { reserveAgent } from '@/lib/mcp/policy';
import { isFreeEvent, recordEvent } from '@/lib/data/presence';
import { EVENT_KINDS, EVENT_NAMES } from '@/lib/data/presence-state';
import { hint } from '@/lib/live';
import { deliverFor, startTurn, type Delivery } from '@/lib/data/deliver';

// The Work OS hook's session-state route (docs/flows/agent-system.md section 11; the worker's hook files report to it).
// POST /api/agent/event, JSON body { event: 'prompt'|'tool'|'notify'|'stop'|'end', kind?: 'permission_prompt'|'idle_prompt'|
// 'elicitation_dialog'|'auth_success'|'other', at?: number }.
//   Authorization: Bearer wst_…  the session token from /api/agent/start, for its own session only. Nothing else opens it:
//                                no device key, no Work OS API key, no OAuth token, no session cookie, no X-API-Key.
//                                The token's owner must still be a member of its organization on every call.
//   event  What happened in the Claude Code session. The server decides the state from it (prompt and tool: working;
//          stop: idle; end: off; notify permission_prompt or elicitation_dialog: waiting at a prompt; idle_prompt: idle;
//          other kinds change nothing). The hook never sends a state, a message text, a path or a session id.
//   at     The hook's clock in ms; clamped to the server's now plus or minus 5 minutes. An event not newer than the
//          stored one changes nothing, so hooks that arrive out of order never step a session back.
//   deliver  true on a prompt, a tool batch or a stop: the answer may carry `deliver: { text, ids, wakeable }`, the text of what is
//            unread for the session (lib/data/deliver.ts), framed and read by handing it over: a prompt and a tool batch get
//            everything, a stop only what may wake a session. Needs a folder on the token's computer for the project (checked
//            every call) and one of 360 reads an hour; without them the answer is the state alone.
//   woke     true on a prompt that is a wake the hook just got (kept only when the server handed out a wake under a minute ago).
// The only row it writes is the token's own presence row (state, turn chain) (the person, the token's session and project), and never creates one.
// No State, feed, activity or Needs writes. The owner's own pages are told to refresh only when the state changes.
// Rate limited per session token, lib/mcp/policy.ts AGENT_PER_HOUR.event (300 an hour). Free: an event that repeats the stored state
// within a minute (answered with no write) and a notification kind that changes nothing; so many tool calls never use it up.
//   200 { state } (state is null when the session's row is gone; `ignored: true` for an event that changes nothing)
//   400 bad body · 401 no or bad credential · 413 body too large · 429 over the hourly limit
// proxy.ts lets this exact path through untouched: this route checks its own credential.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1024;

const Body = z
  .object({
    event: z.enum(EVENT_NAMES),
    kind: z.enum(EVENT_KINDS).optional(),
    at: z.number().finite().optional(),
    deliver: z.boolean().optional(),
    woke: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await authAgentToken(bearerOf(req));
    if (!auth) return unauthorized();
    const { s, device, session } = auth;
    // The hour's budget is spent by every call except an event that repeats the stored state (below).
    const tooMany = () => reply(429, { error: 'Too many Work OS session events from this session in the last hour; try again later.' }, { 'Retry-After': '600' });
    const text = await readCapped(req, MAX_BODY);
    if (text === null) return (await reserveAgent('event', session.id)) ? reply(413, { error: 'body too large' }) : tooMany();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return (await reserveAgent('event', session.id)) ? reply(400, { error: 'The body is not JSON.' }) : tooMany();
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return (await reserveAgent('event', session.id)) ? reply(400, { error: 'The body needs an event and may have a kind and a time; nothing else.' }) : tooMany();

    // An event that repeats the stored state (a tool call while working) is answered with no write and costs no budget;
    // every other event, and a missing row, counts toward the hour (a refused body does too, above).
    const ev = parsed.data;
    const free = await isFreeEvent(s, { sid: session.id, projectId: session.projectId }, ev);
    if (free.free) return await answer({ state: free.state, ...(free.ignored ? { ignored: true } : {}) });
    if (!(await reserveAgent('event', session.id))) return tooMany();
    const r = await recordEvent(s, { sid: session.id, projectId: session.projectId }, ev);
    if (r.changed) hint(s.orgId, new Set([s.userId]), 'claude');
    return await answer({ state: r.state, ...(r.ignored ? { ignored: true } : {}) });

    // The answer; a prompt starts a turn (its chain restarts), and a hook that asked for it is handed what is waiting for the session.
    async function answer(out: { state: string | null; ignored?: boolean }): Promise<Response> {
      if (ev.event === 'prompt') await startTurn(s, session.id, session.projectId, ev.woke === true);
      if (ev.deliver && out.state && (ev.event === 'prompt' || ev.event === 'tool' || ev.event === 'stop')) {
        // Checked on every call: the folder may have been unlinked since the session began. A used-up read budget answers the state alone.
        if ((await projectOnDevice(s, device.id, session.projectId)) && (await reserveAgent('deliver', session.id))) {
          const d = (await deliverFor(s, session.id, session.projectId, ev.event === 'stop' ? 'stop' : 'turn')).delivery;
          if (d) return reply(200, { ...out, deliver: d satisfies Delivery });
        }
      }
      return reply(200, out);
    }
  } catch (err) {
    console.error('[agent/event]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
