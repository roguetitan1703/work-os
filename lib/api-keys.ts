import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { collections, type ApiKeyDoc } from './db';
import { SafeError } from './auth';

// Claude Code API keys: a second kind of credential, accepted ONLY by the MCP endpoint
// (app/api/mcp). proxy.ts and the admin/cron routes use checkToken() (MCP_TOKEN only)
// and never look at these. Only the SHA-256 of a key is stored; the key is shown once.
//
// Format: "wos_" + 32 random bytes, base64url (47 chars).

export const KEY_PREFIX = 'wos_';
const LAST_USED_EVERY_MS = 60_000;

export type ApiKeyInfo = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };
export type VerifiedKey = { id: string; name: string; role: 'claude-code' };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function newKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!n) throw new SafeError('Give the key a name.');
  return n;
}

function toInfo(d: ApiKeyDoc): ApiKeyInfo {
  return { id: d._id, name: d.name, prefix: d.prefix, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt?.toISOString() ?? null };
}

/** Active (unrevoked) keys, newest first. */
export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const docs = await (await collections()).apiKeys.find({ revokedAt: null }).sort({ createdAt: -1 }).toArray();
  return docs.map(toInfo);
}

/** Creates a key and returns it in full. This is the only time the plaintext exists. */
export async function createApiKey(name: string): Promise<{ key: string; info: ApiKeyInfo }> {
  const c = await collections();
  if ((await c.apiKeys.countDocuments({ revokedAt: null })) >= 20) throw new SafeError('At most 20 active keys. Revoke one first.');
  const key = newKey();
  const doc: ApiKeyDoc = {
    _id: randomUUID(),
    name: cleanName(name),
    role: 'claude-code',
    hash: sha256(key),
    prefix: key.slice(0, 8),
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await c.apiKeys.insertOne(doc);
  return { key, info: toInfo(doc) };
}

export async function revokeApiKey(id: string): Promise<void> {
  const r = await (await collections()).apiKeys.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!r.matchedCount) throw new SafeError('That key is already revoked or does not exist.');
}

/** Revokes the key and issues a new one with the same name. */
export async function rotateApiKey(id: string): Promise<{ key: string; info: ApiKeyInfo }> {
  const c = await collections();
  const cur = await c.apiKeys.findOne({ _id: id, revokedAt: null });
  if (!cur) throw new SafeError('That key is already revoked or does not exist.');
  await revokeApiKey(id);
  return createApiKey(cur.name);
}

/**
 * The key record for a presented key, or null. Looks up by hash, then compares the stored
 * hash in constant time. lastUsedAt is written at most once a minute per key.
 */
export async function verifyApiKey(token: string | null | undefined): Promise<VerifiedKey | null> {
  if (!token || !token.startsWith(KEY_PREFIX) || token.length < 40 || token.length > 80) return null;
  const hash = sha256(token);
  const c = await collections();
  const doc = await c.apiKeys.findOne({ hash });
  if (!doc) return null;
  const a = Buffer.from(doc.hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (doc.revokedAt) return null;
  const now = Date.now();
  if (!doc.lastUsedAt || now - doc.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    const cutoff = new Date(now - LAST_USED_EVERY_MS);
    c.apiKeys
      .updateOne({ _id: doc._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lt: cutoff } }] }, { $set: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }
  return { id: doc._id, name: doc.name, role: doc.role };
}
