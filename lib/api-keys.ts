import 'server-only';
import { SafeError } from './auth';
import { getAuth } from './auth-server';
import type { Agent, Caller } from './caller';

// Work OS API keys (docs/auth.md), stored by Better Auth's API key plugin (`apikey` collection; only a hash is kept,
// the key is shown once). Each key belongs to the user who made it, carries the organization it acts in and which
// agent it is for, in its metadata:
//   agent 'claude'       the claude.ai connector: what the old MCP_TOKEN was (no Claude Code rules)
//   agent 'claude-code'  a Claude Code session: what the old wos_ keys were (lib/mcp/policy.ts rules)
// /api/mcp accepts both (app/api/mcp/[[...key]]/route.ts); other API routes accept them through lib/caller.ts.
// Keys are created only here; Better Auth's /api-key/* HTTP endpoints are not served.

export const MAX_KEYS_PER_USER = 20;

export type ApiKeyInfo = { id: string; name: string; prefix: string; agent: Agent; createdAt: string; lastUsedAt: string | null };

type Row = { id: string; name?: string | null; start?: string | null; referenceId: string; metadata?: unknown; createdAt: Date | string; lastRequest?: Date | string | null };

function meta(m: unknown): { agent?: unknown; orgId?: unknown } {
  if (typeof m === 'string') {
    try {
      return JSON.parse(m) ?? {};
    } catch {
      return {};
    }
  }
  return (m as object | null) ?? {};
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function toInfo(r: Row): ApiKeyInfo {
  const m = meta(r.metadata);
  return { id: String(r.id), name: r.name ?? '', prefix: r.start ?? '', agent: m.agent === 'claude' ? 'claude' : 'claude-code', createdAt: iso(r.createdAt)!, lastUsedAt: iso(r.lastRequest) };
}

async function rowsOf(userId: string): Promise<Row[]> {
  const ctx = await (await getAuth()).$context;
  return (await ctx.adapter.findMany<Row>({ model: 'apikey', where: [{ field: 'referenceId', value: userId }], sortBy: { field: 'createdAt', direction: 'desc' } })) ?? [];
}

/** The caller's own keys in their organization, newest first (all agents, or one). */
export async function listApiKeys(c: Caller, agent?: Agent): Promise<ApiKeyInfo[]> {
  return (await rowsOf(c.userId)).filter(r => meta(r.metadata).orgId === c.orgId).map(toInfo).filter(k => !agent || k.agent === agent);
}

function cleanName(name: string): string {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!n) throw new SafeError('Give the key a name.');
  return n;
}

/** Creates a key for the caller and returns it in full. This is the only time the plaintext exists. */
export async function createApiKey(c: Caller, name: string, agent: Agent): Promise<{ key: string; info: ApiKeyInfo }> {
  if (c.via !== 'session') throw new SafeError('Keys are made by a signed-in person.');
  const n = cleanName(name);
  if ((await rowsOf(c.userId)).length >= MAX_KEYS_PER_USER) throw new SafeError(`At most ${MAX_KEYS_PER_USER} keys. Revoke one first.`);
  const auth = await getAuth();
  const k = await auth.api.createApiKey({ body: { name: n, userId: c.userId, metadata: { agent, orgId: c.orgId } } });
  return { key: k.key, info: toInfo({ ...k, referenceId: k.referenceId, metadata: k.metadata }) };
}

/** Revokes (deletes) one of the caller's keys. */
export async function revokeApiKey(c: Caller, id: string): Promise<void> {
  const row = (await rowsOf(c.userId)).find(r => String(r.id) === String(id));
  if (!row) throw new SafeError('That key is already revoked or does not exist.');
  const ctx = await (await getAuth()).$context;
  await ctx.adapter.delete({ model: 'apikey', where: [{ field: 'id', value: row.id }] });
}

/** Deletes every key userId made for orgId (they left it). Their keys for other organizations stay. Returns how many. */
export async function revokeKeysIn(userId: string, orgId: string): Promise<number> {
  const rows = (await rowsOf(userId)).filter(r => meta(r.metadata).orgId === orgId);
  if (!rows.length) return 0;
  const ctx = await (await getAuth()).$context;
  for (const r of rows) await ctx.adapter.delete({ model: 'apikey', where: [{ field: 'id', value: r.id }] });
  return rows.length;
}

/** Revokes the key and issues a new one with the same name and agent. */
export async function rotateApiKey(c: Caller, id: string): Promise<{ key: string; info: ApiKeyInfo }> {
  const row = (await rowsOf(c.userId)).find(r => String(r.id) === String(id));
  if (!row) throw new SafeError('That key is already revoked or does not exist.');
  const info = toInfo(row);
  await revokeApiKey(c, id);
  return createApiKey(c, info.name, info.agent);
}
