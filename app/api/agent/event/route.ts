import { z } from 'zod';
import { projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf, readCapped } from '@/lib/agent-auth';
import { reserveAgent } from '@/lib/mcp/policy';
import { isFreeEvent, recordEvent, setIdentity, setLastResult } from '@/lib/data/presence';
import { EVENT_KINDS, EVENT_NAMES } from '@/lib/data/presence-state';
import { hint } from '@/lib/live';
import { applyAck, deliverFor, sessionRow, startTurn, type Delivery } from '@/lib/data/deliver';
import { stopNudge, type StopNudge } from '@/lib/data/nudges';

// The Work OS hook's session-state route (docs/flows/agent-system.md section 11; the worker's hook files report to it).
// POST /api/agent/event, JSON body { event: 'prompt'|'tool'|'notify'|'stop'|'end', kind?: 'permission_prompt'|'idle_prompt'|
// 'elicitation_dialog'|'auth_success'|'other', at?: number }.
//   Authorization: Bearer wst_…  the session token from /api/agent/start, for its own session only. Nothing else opens it:
//                                no device key, no Work OS API key, no OAuth token, no session cookie, no X-API-Key.
//                                The token's owner must still be a member of its organization on every call.
//   event  What happened in the Claude Code session. The server decides the state from it (prompt and tool: working;
//          stop: idle; end: off; notify permission_prompt or elicitation_dialog: waiting at a prompt; idle_prompt: idle;
//          other kinds change nothing). The hook never sends a state, a message text, a path or a session id (result, above, is the one text).
//   at     The hook's clock in ms; clamped to the server's now plus or minus 5 minutes. An event not newer than the
//          stored one changes nothing, so hooks that arrive out of order never step a session back.
//   deliver  true on a prompt, a tool batch or a stop: the answer may carry `deliver: { text, ids, wakeable }`, the text of what is
//            unread for the session (lib/data/deliver.ts), framed and read by handing it over: a prompt and a tool batch get
//            everything, a stop only what may wake a session. Needs a folder on the token's computer for the project (checked
//            every call) and one of 360 reads an hour; without them the answer is the state alone.
//   nudge    (stop only) { asks?, quiet? }: the hook's two facts. The answer may then carry `nudge: { lines?, declutter? }` for the token's own session
//            and project only (lib/data/nudges.ts stopNudge): Next lines that wait on nobody (up to 3, 120 characters), and the Declutter nudge text.
//            Nothing when the project turned nudges off or the session holds nothing.
//   ack      ids (messages, Needs) the hook printed from the last `deliver`: only then are they read; one not acknowledged is offered
//            again after 20 s (at most 3 offers, then 2 minutes' rest). A wake or a Stop continue is charged when acknowledged.
//   woke     true on a prompt that is a wake the hook just got (kept only when the server handed out a wake under a minute ago).
//   files, reminded  (stop only) H12: whether the changed files were saved to the State ('saved' | 'unsaved') and whether the session
//            was reminded first. copy: 'refused' (tool only): a WORK-STATE.md write the hook refused that never reached this server.
//            Counted on the token's own row (stopCheck, copyEdits) for the owner's Monday numbers; words and a flag, no text or path.
//            An event that carries them is never free.
//   identity (protocol 3) { title?, aiTitle?, model? }, on a prompt or a stop and only when it changed since the last one: the session's own
//            name (a /rename), Claude's title for it, the model. Sets the roster row's label and model (lib/data/presence.ts labelPatch:
//            the session's own name or start_work's label beats Claude's title; a dispatched session keeps its forced label). One line, 120 characters.
//   result   (protocol 4, the result event only, at most 2,000 characters) a subagent's last message from the SubagentStop hook: kept cleaned and cut to 300
//            characters as `lastResult` of the token's own row (lib/data/presence.ts setLastResult), shown to the project's readers marked
//            writtenBy. A result event changes no state and no lastSeen (a background subagent ending after the parent's stop must not make it working). Text of the session, so it is the one thing this route takes besides words: own row only, never creates a row, never free.
//            Protocol 3 hooks (no result) are still accepted.
// The only row it writes is the token's own presence row (state, turn chain) (the person, the token's session and project), and never creates one.
// No State, feed, activity or Needs writes. The owner's own pages are told to refresh only when the state changes.
// Rate limited per session token, lib/mcp/policy.ts AGENT_PER_HOUR.event (300 an hour). Free: an event that repeats the stored state
// within a minute (answered with no write) and a notification kind that changes nothing; so many tool calls never use it up.
//   200 { state } (state is null when the session's row is gone; `ignored: true` for an event that changes nothing)
//   400 bad body · 401 no or bad credential · 413 body too large · 429 over the hourly limit
// proxy.ts lets this exact path through untouched: this route checks its own credential.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 4096; // a result of 2,000 characters can grow in JSON escapes

const Body = z
  .object({
    event: z.enum(EVENT_NAMES),
    kind: z.enum(EVENT_KINDS).optional(),
    at: z.number().finite().optional(),
    deliver: z.boolean().optional(),
    woke: z.boolean().optional(),
    ack: z.array(z.string().max(40)).max(12).optional(),
    // H12, the Monday numbers: words and a flag, never text. files and reminded only with a stop, copy only with a tool.
    files: z.enum(['saved', 'unsaved']).optional(),
    reminded: z.boolean().optional(),
    // Nudges, on a stop only: the hook's two facts (the turn's last message asked the person something; the turn changed no files and Declutter was not nudged today).
    nudge: z.object({ asks: z.boolean().optional(), quiet: z.boolean().optional() }).strict().optional(),
    copy: z.literal('refused').optional(),
    // Protocol 3 (Identity step 4), on a prompt or a stop, only when it changed since the last one: the session's own name, Claude's title for it, the model.
    // Protocol 4 (Lanes step 3), on a result event: a subagent's last message (SubagentStop). The server cleans it and keeps 300 characters as the lane result of the token's own row.
    result: z.string().max(2000).optional(),
    identity: z.object({ title: z.string().max(300).optional(), aiTitle: z.string().max(300).optional(), model: z.string().max(60).optional() }).strict().optional(),
  })
  .strict()
  .refine(b => (b.files === undefined && b.reminded === undefined) || b.event === 'stop', { message: 'files and reminded belong to a stop' })
  .refine(b => b.reminded === undefined || b.files !== undefined, { message: 'reminded goes with files' })
  .refine(b => b.nudge === undefined || b.event === 'stop', { message: 'nudge belongs to a stop' })
  .refine(b => b.copy === undefined || b.event === 'tool', { message: 'copy belongs to a tool event' })
  .refine(b => (b.result === undefined) === (b.event !== 'result'), { message: 'result goes with a result event, and only with it' })
  .refine(b => b.identity === undefined || b.event === 'prompt' || b.event === 'stop', { message: 'identity belongs to a prompt or a stop' });

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
    if (!parsed.success) return (await reserveAgent('event', session.id)) ? reply(400, { error: 'The body needs an event and may have a kind and a time; nothing else (files and reminded go with a stop, copy with a tool, result with a result event).' }) : tooMany();

    // An event that repeats the stored state (a tool call while working) is answered with no write and costs no budget;
    // every other event, and a missing row, counts toward the hour (a refused body does too, above).
    const ev = parsed.data;
    const free = await isFreeEvent(s, { sid: session.id, projectId: session.projectId }, ev);
    if (free.free) return await answer({ state: free.state, ...(free.ignored ? { ignored: true } : {}) });
    if (!(await reserveAgent('event', session.id))) return tooMany();
    const r = await recordEvent(s, { sid: session.id, projectId: session.projectId }, ev);
    const named = ev.identity ? await setIdentity(s, { sid: session.id, projectId: session.projectId }, ev.identity) : false;
    const resulted = ev.result !== undefined ? await setLastResult(s, { sid: session.id, projectId: session.projectId }, ev.result) : false;
    if (r.changed || named || resulted) hint(s.orgId, new Set([s.userId]), 'claude');
    return await answer({ state: r.state, ...(r.ignored ? { ignored: true } : {}) });

    // The answer; a prompt starts a turn (its chain restarts), and a hook that asked for it is handed what is waiting for the session.
    async function answer(out: { state: string | null; ignored?: boolean }): Promise<Response> {
      // What the hook printed from the last offer is acknowledged first: it is read, and a wake is charged and sets the chain the prompt keeps.
      if (ev.ack?.length) await applyAck(s, session.id, session.projectId, ev.ack);
      if (ev.event === 'prompt') await startTurn(s, session.id, session.projectId, ev.woke === true);
      // Nudges (a stop only, the token's own session and project): what the hook needs for the turn-end check and the Declutter nudge.
      let extra: { nudge?: StopNudge } = {};
      if (ev.nudge && ev.event === 'stop' && out.state && session.projectId && (await projectOnDevice(s, device.id, session.projectId))) {
        const row = await sessionRow(s, session.id, session.projectId);
        const n = row ? await stopNudge(s, row, session.projectId, ev.nudge) : null;
        if (n && (n.lines || n.declutter)) extra = { nudge: n };
      }
      if (ev.deliver && out.state && (ev.event === 'prompt' || ev.event === 'tool' || ev.event === 'stop')) {
        // Checked on every call: the folder may have been unlinked since the session began. A used-up read budget answers the state alone.
        const pid = session.projectId; // null: a session outside any project: it gets the messages addressed to it that no project holds
        if ((!pid || (await projectOnDevice(s, device.id, pid))) && (await reserveAgent('deliver', session.id))) {
          const d = (await deliverFor(s, session.id, pid, ev.event === 'stop' ? 'stop' : 'turn')).delivery;
          if (d) return reply(200, { ...out, ...extra, deliver: d satisfies Delivery });
        }
      }
      return reply(200, { ...out, ...extra });
    }
  } catch (err) {
    console.error('[agent/event]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
