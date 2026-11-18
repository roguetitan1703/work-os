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
//     once when its computer is revoked or gets a new key (endDeviceSessions), or when its owner leaves the
//     organization (the route checks the role on every call).
//   - Rate limits: lib/mcp/policy.ts AGENT_PER_HOUR (new sessions per computer, briefs per token).
//   - The device key opens a project only when that project has a folder on the computer (projectOnDevice).

export const AGENT_TOKEN_PREFIX = 'wst_';
export const TOKEN_TTL_MS = 24 * 3_600_000;
const TOKEN_RE = /^wst_[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const idOf = (hash: string) => hash.slice(0, 32);

export type AgentSession = { id: string; deviceId: string; deviceName: string; orgId: string; ownerId: string; projectId: string; expiresAt: Date };

/**
 * Whether a project has a folder on this computer: a folder there linked to it (Claude › Setup or the project's Code
 * tab), or a folder there linked to nothing whose git remote is one of the project's code locations. Read through the
 * device owner's door, so the project must also be one they can read.
 */
export async function projectOnDevice(s: Scope, deviceId: string, projectId: string): Promise<boolean> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  if (!p) return false;
  const remotes = [...new Set((p.code ?? []).map(l => l.remote).filter((r): r is string => !!r))];
  const f = await c.workerFolders.findOne(
    { deviceId, $or: [{ projectId }, ...(remotes.length ? [{ projectId: null, missing: false, remote: { $in: remotes } }] : [])] },
    { projection: { _id: 1 } },
  );
  return !!f;
}

/** A new session token for one project on one computer. Returns the token in full: the only time it exists. */
export async function createAgentSession(s: Scope, deviceId: string, projectId: string): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const now = new Date();
  const doc: AgentSessionDoc = { _id: idOf(hash), hash, deviceId, orgId: s.orgId, ownerId: s.userId, projectId, createdAt: now, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) };
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
  const d = await c.devices.findOne({ _id: doc.deviceId }, { projection: { name: 1, ownerId: 1, orgId: 1, revokedAt: 1 } });
  if (!d || d.revokedAt || d.ownerId !== doc.ownerId || d.orgId !== doc.orgId) return null;
  return { id: doc._id, deviceId: doc.deviceId, deviceName: d.name, orgId: doc.orgId, ownerId: doc.ownerId, projectId: doc.projectId, expiresAt: doc.expiresAt };
}

/** Ends every session token of a computer (its key was replaced, or it was revoked). */
export async function endDeviceSessions(deviceId: string): Promise<void> {
  await (await collections()).agentSessions.deleteMany({ deviceId }); // scope-ok: session tokens of a computer the caller just proved is theirs
}
