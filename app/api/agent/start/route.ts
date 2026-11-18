import { z } from 'zod';
import { verifyDeviceKey, DEVICE_KEY_PREFIX } from '@/lib/devices';
import { AGENT_TOKEN_PREFIX, createAgentSession, projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf as bearer, readCapped } from '@/lib/agent-auth';
import { roleOf } from '@/lib/caller';
import { reserveAgent } from '@/lib/mcp/policy';
import { startWorkBrief } from '@/lib/mcp/server';
import { findProjectByCode } from '@/lib/data/projects';
import { setWhere } from '@/lib/data/states';
import { hookHeader, runWithRequestContext } from '@/lib/request-context';
import { timezoneOf } from '@/lib/profile';
import { InputError, NotFoundError } from '@/lib/data/errors';
import type { Scope } from '@/lib/scope';

// The Work OS hook's sign-in (worker/hook.mjs; docs/flows/agent-system.md sections 4 and 16 item 8; lib/agent-sessions.ts).
// POST /api/agent/start, JSON body { remote?, subdir?, branch?, path?, machine?, label?, model? } (the folder the
// Claude Code session runs in, found like start_work finds it).
//   Authorization: Bearer wkr_…  the PC's worker device key: opens a new session on the project of that folder, only
//                                when a folder on that PC is linked to the project (projectOnDevice; a folder's remote
//                                alone never counts, the worker reports it itself). Answers the start brief and
//                                a session token (wst_…), the only time the token is sent.
//   Authorization: Bearer wst_…  that session token (after a compaction): the same session's brief again, for its own
//                                project only.
// Nothing else opens it: no Work OS API key, no OAuth token, no session cookie, no X-API-Key. The device's owner must
// still be a member of its organization on every call. Rate limited per computer (new sessions) and per session (briefs),
// lib/mcp/policy.ts AGENT_PER_HOUR. The token never goes into the brief, the database or the log.
// Body also takes head, dirty and worktrees (Where, written without a State version bump). The X-Work-OS-Hook header marks the
// hook's protocol (new hooks send 2; none means 1, which still gets the copy in save answers).
//   200 { brief, token?, expiresAt } · 400 bad body · 401 no or bad credential · 403 a token for another project
//   404 no project with a folder on this computer matches · 413 body too large · 429 over the hourly limit
// proxy.ts lets this exact path through untouched: this route checks its own credential.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 8 * 1024;
// One answer for "no project matches" and "that project has no folder on this PC": the two must not be told apart.
const NO_PROJECT = 'No project linked to a folder on this computer matches this folder. Link the folder to its project in Work OS (Claude › Setup, or the project\'s Code tab).';

const Body = z
  .object({
    remote: z.string().max(300).optional(),
    subdir: z.string().max(300).optional(),
    branch: z.string().max(120).optional(),
    path: z.string().max(500).optional(),
    machine: z.string().max(40).optional(),
    label: z.string().max(120).optional(),
    model: z.string().max(60).optional(),
    head: z.string().max(80).optional(),
    dirty: z.boolean().optional(),
    worktrees: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict();
type Body = z.infer<typeof Body>;

/** The project the body's folder belongs to, as the device owner sees it, or null. */
async function lookup(s: Scope, b: Body): Promise<string | null> {
  if (!b.remote && !b.path) return null;
  const m = await findProjectByCode(s, { remote: b.remote, path: b.path, subdir: b.subdir, branch: b.branch });
  return m.matched ? m.project.id : null;
}

function baseUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

export async function POST(req: Request): Promise<Response> {
  try {
    const cred = bearer(req);
    if (!cred) return unauthorized();
    // Who: a session token, else a device key. Anything else is refused before any other work.
    let s: Scope;
    let device: { id: string; name: string };
    let session: { id: string; projectId: string; expiresAt: Date } | null = null;
    if (cred.startsWith(AGENT_TOKEN_PREFIX)) {
      const t = await authAgentToken(cred); // also checks the owner's membership
      if (!t) return unauthorized();
      s = t.s;
      device = t.device;
      session = t.session;
    } else if (cred.startsWith(DEVICE_KEY_PREFIX)) {
      const d = await verifyDeviceKey(cred);
      if (!d?.ownerId || !d.orgId) return unauthorized();
      s = { userId: d.ownerId, orgId: d.orgId };
      device = { id: d.id, name: d.name };
    } else return unauthorized();
    // Its owner must still be a member (removing someone revokes their computers; this holds even if that failed).
    if (!(await roleOf(s.userId, s.orgId))) return unauthorized();
    if (!(await reserveAgent(session ? 'session' : 'device', session ? session.id : device.id))) {
      return reply(429, { error: 'Too many Work OS briefs from this computer in the last hour; try again later.' }, { 'Retry-After': '600' });
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
    return await runWithRequestContext({ userId: s.userId, tz, hook }, async () => {
      let projectId: string;
      if (session) {
        // A token is for its own project only: a folder that belongs to another project gets a new session (device key).
        const found = b.remote || b.path ? await lookup(s, b) : session.projectId;
        if (found !== session.projectId) return reply(403, { error: 'This session token is for another project.' });
        projectId = session.projectId;
      } else {
        const found = await lookup(s, b);
        if (!found) return reply(404, { error: NO_PROJECT });
        projectId = found;
      }
      // Checked again with a token: the folder may have been unlinked since the session began.
      if (!(await projectOnDevice(s, device.id, projectId))) return reply(404, { error: NO_PROJECT });
      let token: string | undefined;
      if (!session) {
        const made = await createAgentSession(s, device.id, projectId, cred);
        token = made.token;
        session = { id: made.id, projectId, expiresAt: made.expiresAt };
      }
      const ctx = { baseUrl: baseUrl(req), caller: { agent: 'claude-code' as const, keyName: `Claude Code on ${device.name}`.slice(0, 80), userId: s.userId, orgId: s.orgId } };
      // The session id is the token row's id (the first 32 hex of the token's SHA-256), never the token.
      // Where this session works: no version bump (lib/data/states.ts setWhere). Only when the hook sent something to show.
      if (b.head || b.dirty !== undefined || b.worktrees || b.branch) await setWhere(s, projectId, b.machine || device.name, { branch: b.branch, head: b.head, dirty: b.dirty, worktrees: b.worktrees });
      // Hook protocol: the X-Work-OS-Hook header; a start without it is the old hook (1, still gets the copy in answers).
      const brief = await startWorkBrief(ctx, projectId, session.id, { hook: hook ?? 1, branch: b.branch, machine: b.machine, label: b.label, model: b.model });
      return reply(200, { brief, ...(token ? { token } : {}), expiresAt: session.expiresAt.toISOString() });
    });
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return reply(400, { error: err.message });
    console.error('[agent/start]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
