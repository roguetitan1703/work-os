import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { collections } from './db';
import { scoped, type Scope } from './scope';

// Run keys: a dispatched run's own Work OS credential (docs/dispatcher.md "Run keys"). The task dispatcher has the worker start
// Claude Code on a task whose text can come from a teammate, so the run must never hold its person's own credential (their
// Claude Code key, OAuth token or device key). Instead the worker asks for a run key (POST /api/worker/run-key, device key)
// just before it starts or resumes a dispatched session, and launches Claude Code with only that key in a strict MCP config.
//
//   - Format "wdr_" + 32 random bytes, base64url (47 chars). Only its SHA-256 is stored, on the run's own worker session row
//     (`runKey`); the key is answered once. One live key per run: a start or resume replaces it.
//   - Made only for this computer's own dispatched worker session row (same device, owner and organization, `dispatched`).
//   - Opens /api/mcp only (no other route takes it). Every call it makes is the person's Claude Code with `dispatched` set:
//     Orders are never writable, mail and Discord tools are refused, the sessions it starts are marked dispatched, and a
//     `session` (argument or header) naming a session that is not this run's is refused (lib/mcp/server.ts, policy.ts).
//   - Dies when it is RUN_KEY_TTL_MS old, when the run ends (the worker reports it stopped, dead or failed), when its
//     computer is revoked or gets a new key, or when its owner leaves the organization (the MCP route checks the role).

export const RUN_KEY_PREFIX = 'wdr_';
export const RUN_KEY_TTL_MS = 24 * 3_600_000;
const RUN_KEY_RE = /^wdr_[A-Za-z0-9_-]{43}$/;
const ENDED = new Set(['stopped', 'dead', 'failed']);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export type RunKeyOwner = { userId: string; orgId: string; deviceId: string; /** The worker session id (Claude Code's session UUID). */ sessionId: string; taskId: string; ref: number };

/**
 * What the worker asks before it starts, resumes or reopens a session (POST /api/worker/run-key):
 *   - `{ plain: true }`: the person has no dispatched run with this id, so the worker opens it as their own session;
 *   - a new run key for this computer's dispatched session `sessionId` (replacing any earlier one; a row the worker had reported
 *     dead or stopped is moved back to starting, since a resume or reopen is about to run it again);
 *   - null: a dispatched run that gets no key (on another computer, failed, its task gone): the worker opens nothing.
 * Returns the key in full: the only time it exists.
 */
export async function mintRunKey(s: Scope, deviceId: string, sessionId: string): Promise<{ key: string; expiresAt: Date; ref: number } | { plain: true } | null> {
  const c = await scoped(s);
  const ws = await c.workerSessions.findOne({ _id: sessionId, ownerId: s.userId, dispatched: true }, { projection: { taskId: 1, state: 1, deviceId: 1 } });
  if (!ws) return { plain: true };
  if (ws.deviceId !== deviceId || !ws.taskId || ws.state === 'failed') return null;
  const task = await c.tasks.findOne({ _id: ws.taskId }, { projection: { ref: 1 } });
  if (!task || !Number.isInteger(task.ref)) return null;
  const dev = await (await collections()).devices.findOne({ _id: deviceId, ownerId: s.userId, orgId: s.orgId, revokedAt: null }, { projection: { hash: 1 } }); // scope-ok: the verified computer's own row, for its key hash
  if (!dev) return null;
  const key = RUN_KEY_PREFIX + randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RUN_KEY_TTL_MS);
  const from = ws.state === 'stopped' || ws.state === 'dead' ? ws.state : undefined;
  const back = from ? { state: 'starting' as const, updatedAt: now } : {};
  const r = await c.workerSessions.updateOne({ _id: sessionId, deviceId, ownerId: s.userId, dispatched: true, state: { $ne: 'failed' } }, { $set: { runKey: { hash: sha256(key), keyHash: dev.hash, ref: task.ref, at: now, expiresAt, ...(from ? { from } : {}) }, ...back } });
  return r.matchedCount ? { key, expiresAt, ref: task.ref } : null;
}

/** Whether `sessionId` is a dispatched run of this person (on any of their computers). Mints nothing: "Open in VS Code" asks it. */
export async function isDispatchedRun(s: Scope, sessionId: string): Promise<boolean> {
  const c = await scoped(s);
  return !!(await c.workerSessions.findOne({ _id: sessionId, ownerId: s.userId, dispatched: true }, { projection: { _id: 1 } }));
}

/**
 * The worker could not launch the run it got `key` for (a reopen whose launch failed): the key dies at once, and a row its mint moved
 * from stopped or dead to starting goes back (a row still starting or running with no `from` becomes dead: nothing runs it).
 * Only this computer's own run and only with the key it was given. Returns whether a key was released.
 */
export async function releaseRunKey(s: Scope, deviceId: string, sessionId: string, key: string): Promise<boolean> {
  if (!RUN_KEY_RE.test(key)) return false;
  const c = await scoped(s);
  const hash = sha256(key);
  const ws = await c.workerSessions.findOne({ _id: sessionId, deviceId, ownerId: s.userId, dispatched: true, 'runKey.hash': hash }, { projection: { state: 1, runKey: 1 } });
  if (!ws) return false;
  const back = ws.state === 'starting' || ws.state === 'running' ? { state: ws.runKey?.from ?? ('dead' as const), updatedAt: new Date() } : {};
  const r = await c.workerSessions.updateOne({ _id: sessionId, deviceId, 'runKey.hash': hash }, { $unset: { runKey: '' }, ...(Object.keys(back).length ? { $set: back } : {}) });
  return r.modifiedCount > 0;
}

/** The run behind a presented run key, or null: unknown, expired, its run ended, or its computer revoked or no longer its owner's. */
export async function verifyRunKey(token: string | null | undefined): Promise<RunKeyOwner | null> {
  if (!token || !RUN_KEY_RE.test(token)) return null;
  const hash = sha256(token);
  const c = await collections(); // scope-ok: run keys: found by the key's hash, then its own computer by id
  const ws = await c.workerSessions.findOne({ 'runKey.hash': hash }, { projection: { runKey: 1, deviceId: 1, ownerId: 1, orgId: 1, dispatched: 1, taskId: 1, state: 1 } });
  const rk = ws?.runKey;
  if (!ws || !rk || !ws.dispatched || !ws.taskId) return null;
  const a = Buffer.from(rk.hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (rk.expiresAt.getTime() <= Date.now() || ENDED.has(ws.state)) return null;
  const d = await c.devices.findOne({ _id: ws.deviceId }, { projection: { ownerId: 1, orgId: 1, revokedAt: 1, hash: 1 } });
  if (!d || d.revokedAt || d.ownerId !== ws.ownerId || d.orgId !== ws.orgId || d.hash !== rk.keyHash) return null;
  return { userId: ws.ownerId, orgId: ws.orgId, deviceId: ws.deviceId, sessionId: ws._id, taskId: ws.taskId, ref: rk.ref };
}
