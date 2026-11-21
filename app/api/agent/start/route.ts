import { z } from 'zod';
import { verifyDeviceKey, DEVICE_KEY_PREFIX } from '@/lib/devices';
import { simulatedStampsAllowed } from '@/lib/cron-at';
import { AGENT_TOKEN_PREFIX, createAgentSession, dispatchedOfToken, dispatchedSession, closeLeftBehind, reopenLeftBehind, restoreDoing, findIdentity, identityById, projectFolderIds, projectOnDevice, projectRemotes, touchIdentity } from '@/lib/agent-sessions';
import { normalizeRemote } from '@/lib/data/code-locations';
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
//   Authorization: Bearer wkr_…  the PC's worker device key: signs the Claude Code session in. A session is (person, computer, Claude Code
//                                session) and has ONE id for good: the server finds its record by ccSession (or, for a /clear, by proc),
//                                else makes it. Answers the start brief and a new session token (wst_…), the only time that token is sent;
//                                a sign-in never deletes another token (two windows). The folder decides the project:
//                                  1. a folder linked on this PC to project Q: the session is on Q (same id, even if it was on P or on none);
//                                  2. no such folder and the session has project P: it stays on P and the answer says elsewhere: true with
//                                     projectFolders (the worker folder ids of P on this PC); no Where and no folder key are written;
//                                  3. no such folder and no project: unfiled (protocol 3: a token that opens only event and wait; older: 404).
//                                An older hook (protocol 3 or less) stays on P from a foreign folder only when it names no remote or one of
//                                P's remotes; otherwise it is unfiled.
//   Authorization: Bearer wst_…  that session token (after a compaction): the same session's brief again, the same way.
//   Body { renew: true, ccSession, proc? } with the device key: a hook whose token ran out gets a new token for the existing session and nothing
//                                else: no brief, folders ignored, the project never changed. 200 { token, expiresAt, session } · 404 no record
//                                for this Claude Code session on this PC. Its own limit (AGENT_PER_HOUR.renew per PC and Claude Code session).
// Nothing else opens it: no Work OS API key, no OAuth token, no session cookie, no X-API-Key. The device's owner must
// still be a member of its organization on every call. Rate limited per computer (sign-ins) and per session (briefs),
// lib/mcp/policy.ts AGENT_PER_HOUR. The token never goes into the brief, the database or the log.
// Body also takes head, dirty and worktrees (Where, written without a State version bump), ccSession (Claude Code's own session
// UUID, kept on the session record and the presence row to find the session again), proc ({ pid, procStart }: the claude process, which links a
// /clear to its session) and source (startup, resume, clear, compact: the session is then on, or working after a compaction). The row's machine
// is the device itself, whatever hostname the body names. The X-Work-OS-Hook header marks the hook's protocol (new hooks send 4; none means 1,
// which still gets the copy in save answers).
//   200 { brief, token?, expiresAt, dispatched?, elsewhere?, projectFolders? } · 400 bad body · 401 no or bad credential
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
    // Hook protocol 4: the claude process (a /clear stays in it) and the renew sign-in (a new token for an existing session, nothing else).
    proc: z.object({ pid: z.number().int().min(1).max(2_147_483_647), procStart: z.string().max(40).optional() }).strict().optional(),
    renew: z.boolean().optional(),
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

/** A write that races another start of the same session (the presence row's upsert) fails once with a duplicate key: the second try finds the row. */
async function again<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if ((e as { code?: number })?.code !== 11000) throw e;
    return f();
  }
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

    // The budgets: a renew has its own (per computer and Claude Code session), so a loop of renews never uses up the 30 sign-ins an hour.
    const allowed = b.renew ? await reserveAgent('renew', `${device.id}:${b.ccSession ?? session?.id ?? 'none'}`) : await reserveAgent(session ? 'session' : 'device', session ? session.id : device.id);
    if (!allowed) return reply(429, { error: 'Too many Work OS briefs from this computer in the last hour; try again later.' }, { 'Retry-After': '600' });

    const hook = hookHeader(req.headers.get('x-work-os-hook'));
    const tz = await timezoneOf(s);
    return await runWithRequestContext({ userId: s.userId, tz, hook }, async () => {
      // The session's record: by its token, else by its Claude Code session id (or the claude process, for a /clear). None yet: made below.
      let identity = session ? await identityById(session.id) : await findIdentity(s, device.id, { ccSession: b.ccSession, proc: b.proc, source: b.source });

      const ctx0 = { baseUrl: baseUrl(req), caller: { agent: 'claude-code' as const, keyName: `Claude Code on ${device.name}`.slice(0, 80), userId: s.userId, orgId: s.orgId } };

      // Renew: a new token for the existing session and nothing else (no brief, no folders, no project change).
      if (b.renew) {
        if (session) return reply(200, { expiresAt: session.expiresAt.toISOString(), session: session.id });
        if (!identity) return reply(404, { error: 'No session record for this Claude Code session on this computer.' });
        // Its folder may no longer be linked on this computer: then it renews unfiled, as a fresh start would.
        const rpid = identity.projectId && (await projectOnDevice(s, device.id, identity.projectId)) ? identity.projectId : null;
        const made = await createAgentSession(s, device.id, rpid, cred, { identity, ccSession: b.ccSession, dispatched: await dispatchedOfToken(identity._id) });
        await touchIdentity(identity, { ccSession: b.ccSession, proc: b.proc, projectId: rpid });
        if (!rpid && identity.projectId) {
          // Unfiled now: its project row ends and the unfiled row opens, as noProjectStart does (events go to that row).
          await closeLeftBehind(s, identity._id, null);
          await again(() => registerUnfiledSession(ctx0, identity!._id, { hook: hook ?? 1, viaHook: true, machine: device.id, ccSession: b.ccSession }, undefined));
        }
        return reply(200, { token: made.token, expiresAt: made.expiresAt.toISOString(), session: identity._id });
      }

      // A session whose folder no project owns is still on the roster, as a session with no project (protocol 3). It gets a token that opens
      // only event and wait, and no brief; it keeps its id, and the id stays when a later start files it. An older hook gets the 404 as before.
      const noProjectStart = async (): Promise<Response> => {
        const quiet = await quietFolder(s, b.machine, b.path);
        const folderName = b.path ? b.path.split(/[\\/]+/).filter(Boolean).pop() : undefined;
        let token: string | undefined;
        let sid: string;
        let until: Date;
        if (session && identity) {
          sid = session.id;
          until = session.expiresAt;
        } else {
          const made = await createAgentSession(s, device.id, null, cred, { identity, ccSession: b.ccSession, proc: b.proc });
          token = made.token;
          sid = made.id;
          until = made.expiresAt;
          identity = made.identity;
        }
        await touchIdentity(identity!, { ccSession: b.ccSession, proc: b.proc, projectId: null });
        await closeLeftBehind(s, sid, null); // it was on a project and is filed nowhere now (an older hook's foreign remote), or on another computer: those rows end
        await again(() => registerUnfiledSession(ctx0, sid, { hook: hook ?? 1, viaHook: true, branch: b.branch, machine: device.id, ccSession: b.ccSession, source: b.source, label: b.label, title: b.title, aiTitle: b.aiTitle, tool: b.tool, model: b.model, account: b.account }, folderName));
        return reply(200, { unfiled: true, ...(quiet ? { quiet: true } : {}), ...(token ? { token } : {}), expiresAt: until.toISOString() });
      };

      // The folder decides (case 1); with no folder of a project here the session stays on the project it has (case 2) or is unfiled (case 3).
      const found = await lookup(s, b, device.id);
      let projectId: string | null = found;
      let elsewhere = false;
      if (!found && identity?.projectId) {
        projectId = identity.projectId;
        elsewhere = true;
        // An older hook (before protocol 5, the identity-aware one) cannot say it is elsewhere: it stays on the project only when it names no remote, or one of the project's own remotes.
        if ((hook ?? 1) < 5 && b.remote) {
          const r = normalizeRemote(b.remote);
          if (r && !(await projectRemotes(s, device.id, projectId)).includes(r)) projectId = null;
        }
      }
      if (!projectId) return (hook ?? 1) >= 3 ? noProjectStart() : unfiled(s, b);
      // Checked again with a token: the folder may have been unlinked since the session began.
      if (!(await projectOnDevice(s, device.id, projectId))) return unfiled(s, b);
      let token: string | undefined;
      // H15: a session the task dispatcher started is marked whatever started it (the PC's own worker session row says so).
      let dispatched: { taskId: string; ref: number } | null = null;
      if (!session) {
        dispatched = b.ccSession ? await dispatchedSession(s, device.id, b.ccSession) : null;
        const made = await createAgentSession(s, device.id, projectId, cred, { identity, dispatched, ccSession: b.ccSession, proc: b.proc });
        token = made.token;
        identity = made.identity;
        session = { id: made.id, projectId, expiresAt: made.expiresAt };
      } else dispatched = await dispatchedOfToken(session.id);
      await touchIdentity(identity!, { ccSession: b.ccSession, proc: b.proc, projectId, ...(token ? { dispatched } : {}) });
      const left = await closeLeftBehind(s, session.id, projectId); // the session is on this project now: its rows on another project, another computer or under an older id close, before the brief
      const ctx = ctx0;
      // The session id is the session record's id, never a token.
      // Hook protocol: the X-Work-OS-Hook header; a start without it is the old hook (1, still gets the copy in answers).
      const sidNow = session.id;
      let brief: Awaited<ReturnType<typeof startWorkBrief>>;
      try {
        // Where this session works: no version bump (lib/data/states.ts setWhere). Only when the hook sent something to show, and never from a folder that is not the project's.
        if (!elsewhere && (b.head || b.dirty !== undefined || b.worktrees || b.branch)) await setWhere(s, projectId, b.machine || device.name, { branch: b.branch, head: b.head, dirty: b.dirty, worktrees: b.worktrees });
        if (req.headers.get('x-e2e-fail-brief') === '1' && simulatedStampsAllowed()) throw new Error('e2e: brief failed'); // test hook: only on a database named workos_e2e*, never on a real one
        brief = await again(() => startWorkBrief(ctx, projectId!, sidNow, { hook: hook ?? 1, viaHook: true, branch: b.branch, machine: device.id, ccSession: b.ccSession, source: b.source, label: b.label, title: b.title, aiTitle: b.aiTitle, tool: b.tool, model: b.model, account: b.account, ...(dispatched ? { dispatched } : {}) }));
      } catch (e) {
        await reopenLeftBehind(s, left, sidNow).catch(() => {}); // the closed row still holds the doing: it opens again, the next start moves it
        throw e;
      }
      await restoreDoing(s, session.id, projectId, left); // what the closed row was doing goes on the new row (it did not exist when the work moved)
      // Lanes step 6: the folder's key (sha1 of the computer and the path, never the path) goes on the row; another live session in it is the brief's sameFolder.
      let sameFolder: Awaited<ReturnType<typeof sameFolderOf>> = null;
      if (!elsewhere) {
        const fk = folderKeyOf(device.id, b.path);
        await setFolderKey(s, { sid: session.id, projectId }, fk);
        sameFolder = await sameFolderOf(s, projectId, fk, hookRowId(s.userId, session.id, projectId));
      }
      const projectFolders = elsewhere ? await projectFolderIds(s, device.id, projectId) : null;
      return reply(200, { brief: sameFolder ? { ...brief, sameFolder } : brief, ...(dispatched ? { dispatched: dispatched.ref } : {}), ...(token ? { token } : {}), expiresAt: session.expiresAt.toISOString(), ...(elsewhere ? { elsewhere: true, projectFolders } : {}) });
    });
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return reply(400, { error: err.message });
    console.error('[agent/start]', err instanceof Error ? err.name : 'error'); // the name only: never a credential or body
    return reply(500, { error: 'internal error' });
  }
}
