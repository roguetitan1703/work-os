import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { collections, type AgentSessionDoc } from './db';
import { scoped, type Scope } from './scope';

// Session tokens for the Work OS hook (docs/flows/agent-system.md sections 4 and 16 item 8; route
// app/api/agent/start/route.ts). A PC is connected once: its worker's device key (wkr_, lib/devices.ts) signs the hook
// in at session start, and the hook gets a session token for that one Claude Code session on that one project. After a
// compaction the hook shows the token instead of the device key and gets the same session back.
//
//   - Format "wst_" + 32 random bytes, base64url (47 chars). Only its SHA-256 is stored; the token is answered once.
//   - The token stands for its session: the session id is the first 32 hex of the token's SHA-256 (the `_id` of its row),
//     so the brief, presence, save_state and the X-Work-OS-Session header use that id and the token itself never
//     reaches the database, the brief or the session's context.
//   - One project, fixed when it is made; expires TOKEN_TTL_MS after it is made (a TTL index deletes the row). Dies at
//     once when its computer is revoked or gets a new key (endDeviceSessions; and the row keeps the hash of the key it
//     was made with, so a token made in a race with a key replace is refused too), or when its owner leaves the
//     organization (the route checks the role on every call).
//   - Rate limits: lib/mcp/policy.ts AGENT_PER_HOUR (new sessions per computer, briefs per token).
//   - The device key opens a project only when a folder on that computer is linked to it (projectOnDevice).

export const AGENT_TOKEN_PREFIX = 'wst_';
export const TOKEN_TTL_MS = 24 * 3_600_000;
const TOKEN_RE = /^wst_[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const idOf = (hash: string) => hash.slice(0, 32);

export type AgentSession = { id: string; deviceId: string; deviceName: string; orgId: string; ownerId: string; /** Null: a session outside any project; its token opens only /api/agent/event and /api/agent/wait. */ projectId: string | null; expiresAt: Date };

/**
 * Whether a folder on this computer is linked to the project (a person links it in the app: Claude › Setup or the
 * project's Code tab), and the worker still reports it. A folder's git remote alone never counts: the worker reports
 * remotes itself, so a stolen device key could claim any remote. Read through the device owner's door, so the project
 * must also be one they can read.
 */
export async function projectOnDevice(s: Scope, deviceId: string, projectId: string): Promise<boolean> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: projectId }, { projection: { _id: 1 } });
  if (!p) return false;
  const f = await c.workerFolders.findOne({ deviceId, projectId, missing: false }, { projection: { _id: 1 } });
  return !!f;
}

/**
 * A new session token for one project on one computer, made with `deviceKey` (its hash is kept on the row and must
 * still be the computer's key when the token is shown). Returns the token in full: the only time it exists.
 */
export async function createAgentSession(s: Scope, deviceId: string, projectId: string | null, deviceKey: string, dispatched?: { taskId: string; ref: number } | null, ccSession?: string): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const now = new Date();
  const doc: AgentSessionDoc = { _id: idOf(hash), hash, keyHash: sha256(deviceKey), deviceId, orgId: s.orgId, ownerId: s.userId, projectId, ...(projectId === null && ccSession ? { ccSession } : {}), createdAt: now, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS), ...(dispatched ? { dispatched } : {}) };
  await (await collections()).agentSessions.insertOne(doc); // scope-ok: session tokens: written for the verified device's owner and organization
  return { token, id: doc._id, expiresAt: doc.expiresAt };
}

/** The session behind a presented token, or null: unknown, expired, or its computer revoked or no longer its owner's. */
export async function verifyAgentToken(token: string | null | undefined): Promise<AgentSession | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = sha256(token);
  const c = await collections(); // scope-ok: session tokens: found by the token's hash, then its own computer by id
  const doc = await c.agentSessions.findOne({ hash });
  if (!doc) return null;
  const a = Buffer.from(doc.hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (doc.expiresAt.getTime() <= Date.now()) return null; // the TTL monitor runs about once a minute
  const d = await c.devices.findOne({ _id: doc.deviceId }, { projection: { name: 1, ownerId: 1, orgId: 1, revokedAt: 1, hash: 1 } });
  if (!d || d.revokedAt || d.ownerId !== doc.ownerId || d.orgId !== doc.orgId) return null;
  if (!doc.keyHash || d.hash !== doc.keyHash) return null; // made with a key the computer no longer has (a replace raced it)
  return { id: doc._id, deviceId: doc.deviceId, deviceName: d.name, orgId: doc.orgId, ownerId: doc.ownerId, projectId: doc.projectId, expiresAt: doc.expiresAt };
}

/**
 * H15: the task the dispatcher started this Claude Code session for, or null. Only this PC's own worker session row counts
 * (same device, same owner and organization, `dispatched: true`; its id is the session id the worker gave Claude Code), so a
 * session the person started by hand, or on another PC, is never marked. The mark only adds refusals (hook-pre-tool.mjs).
 */
export async function dispatchedSession(s: Scope, deviceId: string, ccSession: string): Promise<{ taskId: string; ref: number } | null> {
  const c = await scoped(s);
  const ws = await c.workerSessions.findOne({ _id: ccSession, deviceId, ownerId: s.userId, dispatched: true }, { projection: { taskId: 1 } });
  if (!ws?.taskId) return null;
  const t = await c.tasks.findOne({ _id: ws.taskId }, { projection: { ref: 1 } });
  return t && Number.isInteger(t.ref) ? { taskId: ws.taskId, ref: t.ref } : null;
}

/** The mark a session token's row carries (a later start with the token, after a compaction, answers it again). */
export async function dispatchedOfToken(sessionId: string): Promise<{ taskId: string; ref: number } | null> {
  const doc = await (await collections()).agentSessions.findOne({ _id: sessionId }, { projection: { dispatched: 1 } }); // scope-ok: session tokens: found by the verified session's own id
  return doc?.dispatched ?? null;
}

/**
 * Ends the no-project sessions this person's Claude Code session id has on this computer: the token and the row (Identity step 5).
 * Called when the folder gets a project (the session is filed: it signs in again with a project) and before a new no-project start,
 * so one Claude Code session is never two rows.
 */
export async function endUnfiledSession(s: Scope, deviceId: string, ccSession: string): Promise<void> {
  const c = await collections(); // scope-ok: session tokens of the verified device's owner, found by their own Claude Code session id
  await c.agentSessions.deleteMany({ deviceId, ownerId: s.userId, orgId: s.orgId, projectId: null, ccSession });
  await (await scoped(s)).presence.deleteMany({ userId: s.userId, ccSession, projectId: null });
}

/** Ends every session token of a computer (its key was replaced, or it was revoked). */
export async function endDeviceSessions(deviceId: string): Promise<void> {
  await (await collections()).agentSessions.deleteMany({ deviceId }); // scope-ok: session tokens of a computer the caller just proved is theirs
}
