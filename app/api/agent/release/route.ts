import { z } from 'zod';
import { projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf, readCapped } from '@/lib/agent-auth';
import { reserveAgent } from '@/lib/mcp/policy';
import { agentActor } from '@/lib/actors';
import { RELEASE_WHAT, checkRelease } from '@/lib/data/production';
import { hookHeader, runWithRequestContext } from '@/lib/request-context';
import { timezoneOf } from '@/lib/profile';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The Work OS hook's production check (worker/hook-pre-tool.mjs, worker/hook-release.mjs; docs/flows/agent-system.md section 10).
// POST /api/agent/release, JSON body { what: 'push' | 'tag' | 'release' | 'cli', name?: string (at most 100) }.
//   Authorization: Bearer wst_…  the session token from /api/agent/start, for its own project only. Nothing else opens it:
//                                no device key, no Work OS API key, no OAuth token, no session cookie, no X-API-Key.
//                                The token's owner must still be a member of its organization on every call.
// The hook decides locally that a command is a production push, tag, release or CLI command and asks only then; the command,
// its arguments and the remote's address never leave the PC (`name` is a branch, tag or CLI name).
// Answers whether a release Need to the project's owner is answered and its window (1 or 24 hours) is open. Nothing here opens
// or extends a grant: only the owner's answer in the app does (answerNeed).
//   200 { allowed: true, until, need }      the window is open: one feed row on the project ("Production push (master) under Need #41")
//   200 { allowed: false, open?, owner }    no window; open = the number of a release Need waiting for its answer, owner = their first name
//   400 bad body · 401 no or bad credential · 404 the project has no folder on this computer any more
//   413 body too large · 429 over the hourly limit (lib/mcp/policy.ts AGENT_PER_HOUR.release)
// proxy.ts lets this exact path through untouched: this route checks its own credential.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1024;

const Body = z.object({ what: z.enum(RELEASE_WHAT), name: z.string().max(100).optional() }).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await authAgentToken(bearerOf(req));
    if (!auth) return unauthorized();
    const { s, device, session } = auth;
    if (!(await reserveAgent('release', session.id))) {
      return reply(429, { error: 'Too many production checks from this session in the last hour; try again later.' }, { 'Retry-After': '600' });
    }

    const text = await readCapped(req, MAX_BODY);
    if (text === null) return reply(413, { error: 'body too large' });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reply(400, { error: 'The body is not JSON.' });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return reply(400, { error: 'The body takes what (push, tag, release or cli) and an optional short name, nothing else.' });
    const b = parsed.data;

    const hook = hookHeader(req.headers.get('x-work-os-hook'));
    const tz = await timezoneOf(s);
    return await runWithRequestContext({ userId: s.userId, tz, hook, sid: session.id, src: session.id }, async () => {
      // Checked on every call: the folder may have been unlinked since the session began.
      if (!(await projectOnDevice(s, device.id, session.projectId))) return reply(404, { error: 'This project has no folder on this computer any more.' });
      return reply(200, await checkRelease(s, session.projectId, b.what, b.name, agentActor('claude-code', s.userId)));
    });
  } catch (err) {
    if (err instanceof InputError) return reply(400, { error: err.message });
    if (err instanceof NotFoundError) return reply(404, { error: 'not found' });
    console.error('[agent/release]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
