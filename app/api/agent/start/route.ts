import { z } from 'zod';
import { verifyDeviceKey, DEVICE_KEY_PREFIX } from '@/lib/devices';
import { AGENT_TOKEN_PREFIX, createAgentSession, dispatchedOfToken, endUnfiledSession, dispatchedSession, projectOnDevice } from '@/lib/agent-sessions';
import { agentReply as reply, agentUnauthorized as unauthorized, authAgentToken, bearerOf as bearer, readCapped } from '@/lib/agent-auth';
import { roleOf } from '@/lib/caller';
import { reserveAgent } from '@/lib/mcp/policy';
import { registerUnfiledSession, startWorkBrief } from '@/lib/mcp/server';
import { linkedFolderProject } from '@/lib/data/launcher';
import { folderKeyOf, hookRowId, sameFolderOf, setFolderKey } from '@/lib/data/presence';
import { quietFolder } from '@/lib/data/quiet-folders';
import { setWhere } from '@/lib/data/states';
import { hookHeader, runWithRequestContext } from '@/lib/request-context';
import { timezoneOf } from '@/lib/profile';
import { InputError, NotFoundError } from '@/lib/data/errors';
import type { Scope } from '@/lib/scope';

// The Work OS hook's sign-in (worker/hook.mjs; docs/flows/agent-system.md sections 4 and 16 item 8; lib/agent-sessions.ts).
// POST /api/agent/start, JSON body { folders?, remote?, subdir?, branch?, path?, machine?, label?, model? } (the folder the
// Claude Code session runs in: the worker folder ids that contain it decide the project, H13; remote, subdir and branch are
// information only: a body without folders finds no project). title, aiTitle, tool and model (protocol 3) name the session on the roster.
//   Authorization: Bearer wkr_…  the PC's worker device key: opens a new session on the project of that folder, only
//                                when a folder on that PC is linked to the project (projectOnDevice; a folder's remote
//                                alone never counts, the worker reports it itself). Answers the start brief and
//                                a session token (wst_…), the only time the token is sent.
//   Authorization: Bearer wst_…  that session token (after a compaction): the same session's brief again, for its own
//                                project only.
// Nothing else opens it: no Work OS API key, no OAuth token, no session cookie, no X-API-Key. The device's owner must
// still be a member of its organization on every call. Rate limited per computer (new sessions) and per session (briefs),
// lib/mcp/policy.ts AGENT_PER_HOUR. The token never goes into the brief, the database or the log.
// Body also takes head, dirty and worktrees (Where, written without a State version bump), ccSession (Claude Code's own session
// UUID, kept on the presence row only to join the worker's session list; never shown) and source (startup, resume, clear, compact:
// the session is then on, or working after a compaction). The row's machine is the device itself, whatever hostname the body names. The X-Work-OS-Hook header marks the
// hook's protocol (new hooks send 2; none means 1, which still gets the copy in save answers).
//   200 { brief, token?, expiresAt, dispatched? } · 400 bad body · 401 no or bad credential · 403 a token for another project
//   404 { error, unfiled: true, quiet? } no project with a folder on this computer owns this folder (quiet: the person marked it not Work OS) · 413 body too large · 429 over the hourly limit
// dispatched (H15): the task ref, answered when this PC's own worker session row for ccSession says the task dispatcher started
// it; the presence row then carries it and its label is forced to "<Project> · worker · #<ref>".
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
    // H13: the ids of the worker folders that contain the session's folder (and its main worktree), longest first; the first one linked on this computer decides the project.
    folders: z.array(z.string().regex(/^[A-Za-z0-9_-]{4,40}$/)).max(8).optional(),
    machine: z.string().max(40).optional(),
    label: z.string().max(120).optional(),
    model: z.string().max(60).optional(),
    // The Claude account's label (the email's part before @, worker/claude-account.mjs); one that looks like an email or a key is dropped, the start goes on.
    account: z.string().max(400).optional(), // longer than 40 is dropped below: a label never fails a start
    // Hook protocol 3 (Identity step 4): the session's own name (a /rename), Claude's title for it and where it runs. One line each, cut to 120 characters on the server.
    title: z.string().max(300).optional(),
    aiTitle: z.string().max(300).optional(),
    tool: z.enum(['desktop', 'vscode', 'terminal']).optional(),
    ccSession: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
    source: z.enum(['startup', 'resume', 'clear', 'compact']).optional(),
    head: z.string().max(80).optional(),
    dirty: z.boolean().optional(),
    worktrees: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict();
type Body = z.infer<typeof Body>;

/** The project the body's folder belongs to, as the device owner sees it, or null. The folder decides (H13): the first of `folders` linked on this computer. A body without `folders` finds nothing; a remote never decides. */
async function lookup(s: Scope, b: Body, deviceId: string): Promise<string | null> {
  if (!b.folders) return null;
  return (await linkedFolderProject(s, deviceId, b.folders))?.projectId ?? null;
}

/** The one 404: no project owns this folder (unfiled); `quiet` when the person marked the folder not Work OS. Never names a project. */
async function unfiled(s: Scope, b: Body): Promise<Response> {
  const quiet = await quietFolder(s, b.machine, b.path);
  return reply(404, { error: NO_PROJECT, unfiled: true, ...(quiet ? { quiet: true } : {}) });
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
    let session: { id: string; projectId: string | null; expiresAt: Date } | null = null;
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
    if (b.account && (b.account.length > 40 || /@|^\s*(sk-|wkr_|wos_|ghp_|xox)/i.test(b.account) || /[A-Za-z0-9_-]{32,}/.test(b.account))) delete b.account; // the same test as start_work's account

    const hook = hookHeader(req.headers.get('x-work-os-hook'));
    const tz = await timezoneOf(s);
    return await runWithRequestContext({ userId: s.userId, tz, hook }, async () => {
      const ctx0 = { baseUrl: baseUrl(req), caller: { agent: 'claude-code' as const, keyName: `Claude Code on ${device.name}`.slice(0, 80), userId: s.userId, orgId: s.orgId } };
      // Protocol 3 (Identity step 5): a session whose folder no project owns is still on the roster, as a session with no project. It gets
      // a token that opens only event and wait, and no brief. An older hook gets the 404 as before.
      const noProjectStart = async (): Promise<Response> => {
        const quiet = await quietFolder(s, b.machine, b.path);
        const folderName = b.path ? b.path.split(/[\\/]+/).filter(Boolean).pop() : undefined;
        let token: string | undefined;
        let sid: string;
        let until: Date;
        if (session) {
          sid = session.id;
          until = session.expiresAt;
        } else {
          if (b.ccSession) await endUnfiledSession(s, device.id, b.ccSession); // one Claude Code session is one row
          const made = await createAgentSession(s, device.id, null, cred, null, b.ccSession);
          token = made.token;
          sid = made.id;
          until = made.expiresAt;
        }
        await registerUnfiledSession(ctx0, sid, { hook: hook ?? 1, viaHook: true, branch: b.branch, machine: device.id, ccSession: b.ccSession, source: b.source, label: b.label, title: b.title, aiTitle: b.aiTitle, tool: b.tool, model: b.model, account: b.account }, folderName);
        return reply(200, { unfiled: true, ...(quiet ? { quiet: true } : {}), ...(token ? { token } : {}), expiresAt: until.toISOString() });
      };
      let projectId: string;
      if (session) {
        // A token is for its own project only: a folder that belongs to another project gets a new session (device key).
        const found = b.folders ? await lookup(s, b, device.id) : session.projectId;
        if (found !== session.projectId) return reply(403, { error: 'This session token is for another project.' });
        if (session.projectId === null) return noProjectStart();
        projectId = session.projectId;
      } else {
        const found = await lookup(s, b, device.id);
        if (!found) return (hook ?? 1) >= 3 ? noProjectStart() : unfiled(s, b);
        projectId = found;
      }
      // Checked again with a token: the folder may have been unlinked since the session began.
      if (!(await projectOnDevice(s, device.id, projectId))) return unfiled(s, b);
      let token: string | undefined;
      // H15: a session the task dispatcher started is marked whatever started it (the PC's own worker session row says so).
      let dispatched: { taskId: string; ref: number } | null = null;
      if (!session) {
        dispatched = b.ccSession ? await dispatchedSession(s, device.id, b.ccSession) : null;
        if (b.ccSession) await endUnfiledSession(s, device.id, b.ccSession); // the folder has a project now: the no-project row and token end
        const made = await createAgentSession(s, device.id, projectId, cred, dispatched);
        token = made.token;
        session = { id: made.id, projectId, expiresAt: made.expiresAt };
      } else dispatched = await dispatchedOfToken(session.id);
      const ctx = ctx0;
      // The session id is the token row's id (the first 32 hex of the token's SHA-256), never the token.
      // Where this session works: no version bump (lib/data/states.ts setWhere). Only when the hook sent something to show.
      if (b.head || b.dirty !== undefined || b.worktrees || b.branch) await setWhere(s, projectId, b.machine || device.name, { branch: b.branch, head: b.head, dirty: b.dirty, worktrees: b.worktrees });
      // Hook protocol: the X-Work-OS-Hook header; a start without it is the old hook (1, still gets the copy in answers).
      const brief = await startWorkBrief(ctx, projectId, session.id, { hook: hook ?? 1, viaHook: true, branch: b.branch, machine: device.id, ccSession: b.ccSession, source: b.source, label: b.label, title: b.title, aiTitle: b.aiTitle, tool: b.tool, model: b.model, account: b.account, ...(dispatched ? { dispatched } : {}) });
      // Lanes step 6: the folder's key (sha1 of the computer and the path, never the path) goes on the row; another live session in it is the brief's sameFolder.
      const fk = folderKeyOf(device.id, b.path);
      await setFolderKey(s, { sid: session.id, projectId }, fk);
      const sameFolder = await sameFolderOf(s, projectId, fk, hookRowId(s.userId, session.id, projectId));
      return reply(200, { brief: sameFolder ? { ...brief, sameFolder } : brief, ...(dispatched ? { dispatched: dispatched.ref } : {}), ...(token ? { token } : {}), expiresAt: session.expiresAt.toISOString() });
    });
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return reply(400, { error: err.message });
    console.error('[agent/start]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
