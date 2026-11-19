import { z } from 'zod';
import { projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf, noProject, readCapped } from '@/lib/agent-auth';
import { reserveAgent } from '@/lib/mcp/policy';
import { scoped } from '@/lib/scope';
import { agentActor } from '@/lib/actors';
import { editCopyLine, getState, holdsNowOf, setWhere, stateCopy } from '@/lib/data/states';
import { countCopyEdit, hookRowId } from '@/lib/data/presence';
import { hookHeader, runWithRequestContext } from '@/lib/request-context';
import { timezoneOf } from '@/lib/profile';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The Work OS hook's State route (worker/hook.mjs; docs/flows/agent-system.md sections 16.2-16.4).
// POST /api/agent/state, JSON body { where?: { machine?, branch?, head?, dirty?, worktrees? }, edit?: { old, new } }.
//   Authorization: Bearer wst_…  the session token from /api/agent/start, for its own project only. Nothing else opens it:
//                                no device key, no Work OS API key, no OAuth token, no session cookie, no X-API-Key.
//                                The token's owner must still be a member of its organization on every call.
//   where  Where this session works (no State version bump).
//   edit   One line of WORK-STATE.md changed by an Edit tool call: applied to the State as an edit_line (editCopyLine),
//          as the Claude Code agent of the token's owner. Several lines, the header, Decisions and the marks of a line are refused.
//          Each edit is counted once on the session's own row (copyEdits.forwarded or .refused, H12): numbers only.
// Always answers the copy of the token's project (the same text get_state copy:true gives), so the hook can write the file,
// and holdsNow: whether this session holds the State's Now (Lanes step 1). There is no commit field: every session's hook commits only the copy file itself.
// Rate limited per session token, lib/mcp/policy.ts AGENT_PER_HOUR.state.
//   200 { project, version, markdown, holdsNow, applied? } · 400 bad body or an edit refused · 401 no or bad credential
//   404 the project has no folder on this computer any more · 413 body too large · 429 over the hourly limit
// proxy.ts lets this exact path through untouched: this route checks its own credential.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 16 * 1024;

const Body = z
  .object({
    where: z
      .object({
        machine: z.string().max(40).optional(),
        branch: z.string().max(120).optional(),
        head: z.string().max(80).optional(),
        dirty: z.boolean().optional(),
        worktrees: z.array(z.string().max(200)).max(20).optional(),
      })
      .strict()
      .optional(),
    edit: z.object({ old: z.string().min(1).max(4000), new: z.string().max(4000) }).strict().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await authAgentToken(bearerOf(req));
    if (!auth) return unauthorized();
    const { s, device, session } = auth;
    const sessionProject = session.projectId;
    if (!sessionProject) return noProject(); // a session outside any project: its token takes only events and waits
    if (!(await reserveAgent('state', session.id))) {
      return reply(429, { error: 'Too many Work OS State calls from this session in the last hour; try again later.' }, { 'Retry-After': '600' });
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
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return reply(400, { error: 'The body has fields this route does not take, or values that are too long.' });
    const b = parsed.data;

    const hook = hookHeader(req.headers.get('x-work-os-hook'));
    const tz = await timezoneOf(s);
    // src as MCP calls name a session (userId:sid): holds and line stamps compare it (Lanes step 1).
    const src = `${s.userId}:${session.id}`;
    return await runWithRequestContext({ userId: s.userId, tz, hook, sid: session.id, src }, async () => {
      // Checked on every call: the folder may have been unlinked since the session began.
      if (!(await projectOnDevice(s, device.id, sessionProject))) return reply(404, { error: 'This project has no folder on this computer any more.' });
      const projectId = sessionProject;
      let applied: { version: number; closedTasks: number[]; sentForReview: number[] } | undefined;
      if (b.edit) {
        // H12: counted here once, what reached the server (the hook counts only what never did): an edit refused with 400, or applied.
        const mine = { sid: session.id, projectId };
        let r;
        try {
          r = await editCopyLine(s, projectId, b.edit.old, b.edit.new, { actor: agentActor('claude-code', s.userId), via: 'code' });
        } catch (e) {
          if (e instanceof InputError) await countCopyEdit(s, mine, 'refused');
          throw e;
        }
        if (r.conflict) {
          await countCopyEdit(s, mine, 'refused');
          return reply(400, { error: 'The State changed while the edit was made; read the file again and repeat it.' });
        }
        await countCopyEdit(s, mine, 'forwarded');
        applied = { version: r.state.version, closedTasks: r.closedTasks, sentForReview: r.sentForReview };
      }
      if (b.where) await setWhere(s, projectId, b.where.machine || device.name, b.where);
      const { project, state } = await getState(s, projectId);
      if (!state) return reply(404, { error: 'The project has no State yet.' });
      const baseUrl = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
      const markdown = await stateCopy(s, project, state, baseUrl);
      const holds = holdsNowOf(state, src);
      return reply(200, { project: project._id, version: state.version, markdown, holdsNow: holds, ...(applied ? { applied } : {}) });
    });
  } catch (err) {
    if (err instanceof InputError) return reply(400, { error: err.message });
    if (err instanceof NotFoundError) return reply(404, { error: 'not found' });
    console.error('[agent/state]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
