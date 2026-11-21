import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { collections, type AgentIdentityDoc, type AgentSessionDoc, type PresenceDoc } from './db';
import { scoped, type Scope } from './scope';
import { normalizeRemote } from './data/code-locations';
import { busy } from './data/lanes';
import { hookRowId } from './data/presence';
import { moveSessionWork } from './session-move';

// Sessions and session tokens for the Work OS hook (docs/flows/agent-system.md sections 4 and 16 item 8; route
// app/api/agent/start/route.ts). A PC is connected once: its worker's device key (wkr_, lib/devices.ts) signs the hook in.
//
//   - A session is one person, one computer and one Claude Code session. It has a record (agentIdentities) with one id that never
//     changes: not on a project move, not when it is filed or unfiled, not on /clear (the same claude process, found by pid and start
//     time) and not on a resume. The id is the session id of the brief, presence, save_state and the X-Work-OS-Session header.
//   - A token is a key to a session, not the session. "wst_" + 32 random bytes, base64url (47 chars); only its SHA-256 is stored (the
//     `_id` of its row is the first 32 hex; the first token of a session gives the session its id). One session can hold several
//     valid tokens (two windows), so a sign-in deletes nothing. A token row names its session (`sessionId`; none = an older row, whose
//     session id is its own `_id`).
//   - A token expires TOKEN_TTL_MS after it was made or last used (a TTL index deletes the row); using it moves the expiry forward
//     (authAgentToken). A hook whose token ran out signs in again with the device key and `renew` (the same session, no brief). A token
//     dies at once when its computer is revoked or gets a new key (endDeviceSessions; the row keeps the hash of the key it was made with,
//     so a token made in a race with a key replace is refused too), or when its owner leaves the organization (the route checks the
//     role on every call). The session record survives a key replace.
//   - Rate limits: lib/mcp/policy.ts AGENT_PER_HOUR (new sessions per computer, briefs per token, renews per Claude session).
//   - The device key opens a project only when a folder on that computer is linked to it (projectOnDevice).

export const AGENT_TOKEN_PREFIX = 'wst_';
export const TOKEN_TTL_MS = 24 * 3_600_000;
/** How long a token lives: the env var AGENT_TOKEN_TTL_MS shortens it for tests, and is read only outside production. */
export function tokenTtlMs(): number {
  const v = Number(process.env.AGENT_TOKEN_TTL_MS);
  return process.env.NODE_ENV !== 'production' && Number.isFinite(v) && v > 0 ? v : TOKEN_TTL_MS;
}
const TOKEN_RE = /^wst_[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const idOf = (hash: string) => hash.slice(0, 32);

/** The pid and start time of the claude process a session runs in (the hook's .proc file). /clear stays in the same process. */
export type AgentProc = { pid: number; procStart?: string };

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

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

/** The session record by id, or null. */
export async function identityById(sid: string): Promise<AgentIdentityDoc | null> {
  return (await collections()).agentIdentities.findOne({ _id: sid }); // scope-ok: session records: found by the verified session's own id
}

/**
 * The record of a Claude Code session on this computer (this person, this organization): by its Claude Code session id, else, for a
 * /clear (`source` clear), by the claude process (pid and start time; a start time is required: a pid alone is reused). Null: none yet.
 */
export async function findIdentity(s: Scope, deviceId: string, o: { ccSession?: string; proc?: AgentProc; source?: string }): Promise<AgentIdentityDoc | null> {
  const c = await collections(); // scope-ok: session records of the verified device's owner and organization
  const mine = { ownerId: s.userId, orgId: s.orgId, deviceId };
  if (o.ccSession) {
    const f = await c.agentIdentities.findOne({ ...mine, ccSessions: o.ccSession });
    if (f) return f;
  }
  if (o.source === 'clear' && o.proc?.procStart) return c.agentIdentities.findOne({ ...mine, 'proc.pid': o.proc.pid, 'proc.procStart': o.proc.procStart }, { sort: { lastSeen: -1 } });
  return null;
}

/**
 * A new token for a session of one computer, made with `deviceKey` (its hash is kept on the row and must still be the computer's key
 * when the token is used). With `identity` it is another key to that session; without, it makes the session (its id is the token's
 * `_id`) and its record; a start that races another for the same Claude Code session joins the record that won. Returns the token in
 * full: the only time it exists.
 */
export async function createAgentSession(s: Scope, deviceId: string, projectId: string | null, deviceKey: string, o: { identity?: AgentIdentityDoc | null; dispatched?: { taskId: string; ref: number } | null; ccSession?: string; proc?: AgentProc } = {}): Promise<{ token: string; id: string; expiresAt: Date; identity: AgentIdentityDoc }> {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const now = new Date();
  const c = await collections(); // scope-ok: session tokens and records: written for the verified device's owner and organization
  let identity = o.identity ?? null;
  if (!identity) {
    const rec: AgentIdentityDoc = { _id: idOf(hash), orgId: s.orgId, ownerId: s.userId, deviceId, ccSessions: o.ccSession ? [o.ccSession] : [], projectId, ...(o.proc ? { proc: o.proc } : {}), createdAt: now, lastSeen: now, ...(o.dispatched ? { dispatched: o.dispatched } : {}) };
    try {
      await c.agentIdentities.insertOne(rec);
      identity = rec;
    } catch (e) {
      if (!isDup(e) || !o.ccSession) throw e;
      identity = await findIdentity(s, deviceId, { ccSession: o.ccSession });
      if (!identity) throw e;
    }
  }
  const doc: AgentSessionDoc = { _id: idOf(hash), hash, sessionId: identity._id, keyHash: sha256(deviceKey), deviceId, orgId: s.orgId, ownerId: s.userId, projectId, ...(o.ccSession ? { ccSession: o.ccSession } : {}), createdAt: now, expiresAt: new Date(now.getTime() + tokenTtlMs()), ...(o.dispatched ? { dispatched: o.dispatched } : {}) };
  await c.agentSessions.insertOne(doc);
  return { token, id: identity._id, expiresAt: doc.expiresAt, identity };
}

/**
 * What a start records on its session's record: the Claude Code session id (a /clear gives the same session a new one; one that
 * already belongs to another record stays there), the claude process, the project (null: filed nowhere) and the time.
 */
export async function touchIdentity(identity: AgentIdentityDoc, o: { ccSession?: string; proc?: AgentProc; projectId: string | null; /** A sign-in with the device key says afresh whether the dispatcher started it (null: not); left alone when not given. */ dispatched?: { taskId: string; ref: number } | null }): Promise<void> {
  const c = await collections(); // scope-ok: session records: found by the verified session's own id
  if (o.ccSession && !identity.ccSessions.includes(o.ccSession)) {
    try {
      await c.agentIdentities.updateOne({ _id: identity._id }, { $addToSet: { ccSessions: o.ccSession } });
    } catch (e) {
      if (!isDup(e)) throw e;
    }
  }
  await c.agentIdentities.updateOne({ _id: identity._id }, { $set: { projectId: o.projectId, lastSeen: new Date(), ...(o.proc ? { proc: o.proc } : {}), ...(o.dispatched ? { dispatched: o.dispatched } : {}) }, ...(o.dispatched === null ? { $unset: { dispatched: '' as const } } : {}) });
}

/**
 * The close at sign-in (plan note db5bf91389, B3), run by the start route before the brief. The session `sid` works on `projectId` (null:
 * unfiled) now; what an earlier id or place of the same Claude Code session left behind is closed so one row holds the work:
 *   - an open hook row of this session's Claude Code session ids, on this computer and this project, under another id (an older start
 *     before ids were stable): its work moves to the session's row (lib/session-move.ts) and it ends;
 *   - an open row of the session on another project (or none), or of its Claude Code session ids under another project or on another
 *     computer: it ends only (the sweep, lib/data/pickup.ts, hands its work on later).
 * A busy row (working, or at a permission prompt) under another id is never closed (it may be a live writer; the session's own rows end whatever they show, since their last event came before the move), and a start_work row (no Claude Code session id) is never touched.
 */
export async function closeLeftBehind(s: Scope, sid: string, projectId: string | null): Promise<void> {
  const rec = await identityById(sid);
  if (!rec || rec.ownerId !== s.userId) return;
  const c = await scoped(s);
  const now = Date.now();
  const ccs = rec.ccSessions ?? [];
  const rows = await c.presence.find({ userId: s.userId, endedAt: { $exists: false }, $or: [{ session: sid }, ...(ccs.length ? [{ ccSession: { $in: ccs } }] : [])] }).limit(50).toArray();
  const toId = hookRowId(s.userId, sid, projectId);
  let to: PresenceDoc | null | undefined;
  for (const r of rows) {
    if (r._id === toId) continue; // the session's own row on this project
    if (r.session !== sid && !(r.ccSession && ccs.includes(r.ccSession))) continue;
    if (r.session !== sid && busy(r, now)) continue; // the session's own rows end whatever they show (their last event was before the move)
    const here = !!projectId && r.projectId === projectId && !!r.session && r.session !== sid && r.machine === rec.deviceId;
    if (here) {
      if (to === undefined) to = await c.presence.findOne({ _id: toId });
      await moveSessionWork(c as never, projectId!, r, to ?? { _id: toId, userId: s.userId, key: sid, session: sid }, now);
    } else await c.presence.updateOne({ _id: r._id, endedAt: { $exists: false } }, { $set: { endedAt: new Date(now) } });
  }
}

/** The worker folder ids of a project on a computer, for a session that stays on its project from a folder that is not one of them. */
export async function projectFolderIds(s: Scope, deviceId: string, projectId: string): Promise<string[]> {
  const rows = await (await scoped(s)).workerFolders.find({ deviceId, projectId, missing: false }, { projection: { folderId: 1 } }).limit(20).toArray();
  return rows.map(r => r.folderId);
}

/** The git remotes (normalized) of a project's folders on a computer: an older hook's remote decides whether it is still in the project. */
export async function projectRemotes(s: Scope, deviceId: string, projectId: string): Promise<string[]> {
  const rows = await (await scoped(s)).workerFolders.find({ deviceId, projectId, missing: false }, { projection: { remote: 1 } }).limit(20).toArray();
  return rows.map(r => normalizeRemote(r.remote)).filter((x): x is string => !!x);
}

/** The session behind a presented token, or null: unknown, expired, or its computer revoked or no longer its owner's. A token in use moves its expiry forward. */
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
  // The session's own record; a token older than the records gets one now (its session id is its own row id).
  const sid = doc.sessionId ?? doc._id;
  let rec = await c.agentIdentities.findOne({ _id: sid, ownerId: doc.ownerId, orgId: doc.orgId });
  if (!rec) {
    const fresh: AgentIdentityDoc = { _id: sid, orgId: doc.orgId, ownerId: doc.ownerId, deviceId: doc.deviceId, ccSessions: doc.ccSession ? [doc.ccSession] : [], projectId: doc.projectId, createdAt: doc.createdAt, lastSeen: new Date(), ...(doc.dispatched ? { dispatched: doc.dispatched } : {}) };
    try {
      await c.agentIdentities.insertOne(fresh);
      rec = fresh;
    } catch (e) {
      if (!isDup(e)) throw e;
      rec = await c.agentIdentities.findOne({ _id: sid, ownerId: doc.ownerId, orgId: doc.orgId }); // another call made it just now
      if (!rec) {
        // Its Claude Code session already belongs to another record: this one is kept without it.
        rec = { ...fresh, ccSessions: [] };
        await c.agentIdentities.insertOne(rec).catch(() => {});
      }
    }
  }
  // A token in use stays valid: under 23 of 24 hours left, its expiry moves to a full term (so at most one write an hour per token).
  let expiresAt = doc.expiresAt;
  const ttl = tokenTtlMs();
  if (doc.expiresAt.getTime() - Date.now() < (ttl * 23) / 24) {
    const next = new Date(Date.now() + ttl);
    await c.agentSessions.updateOne({ _id: doc._id, expiresAt: doc.expiresAt }, { $set: { expiresAt: next } });
    await c.agentIdentities.updateOne({ _id: sid }, { $set: { lastSeen: new Date() } }); // the record's 90-day expiry counts from the last use
    expiresAt = next;
  }
  return { id: sid, deviceId: doc.deviceId, deviceName: d.name, orgId: doc.orgId, ownerId: doc.ownerId, projectId: rec.projectId, expiresAt };
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
  const c = await collections(); // scope-ok: session records and tokens: found by the verified session's own id
  const rec = await c.agentIdentities.findOne({ _id: sessionId }, { projection: { dispatched: 1 } });
  if (rec?.dispatched) return rec.dispatched;
  return (await c.agentSessions.findOne({ _id: sessionId }, { projection: { dispatched: 1 } }))?.dispatched ?? null;
}

/** Ends every session token of a computer (its key was replaced, or it was revoked). */
export async function endDeviceSessions(deviceId: string): Promise<void> {
  await (await collections()).agentSessions.deleteMany({ deviceId }); // scope-ok: session tokens of a computer the caller just proved is theirs
}
