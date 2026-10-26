import 'server-only';
import { createHash } from 'node:crypto';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { SafeError, authSecret } from './auth';
import { getAuth } from './auth-server';
import { personOf, roleOf, type Agent, type Caller } from './caller';
import { OAUTH_SCOPE, UNUSED_CLIENT_HOURS, mcpResource } from './oauth-config';
import { timezoneOf } from './profile';

// OAuth sign-in for MCP clients (docs/auth.md "Connecting Claude with OAuth"). Better Auth's OAuth provider plugin
// (lib/auth-server.ts) does registration, authorization, tokens and revocation; this file is the resource side: what
// /api/mcp does with a token, and what Settings › Connections shows and revokes. Tokens are opaque, stored hashed, and
// looked up in the database on every call, so a revoked token, a removed member or a disabled client stops at once.

export const OAUTH_ACCESS_PREFIX = 'wosat_';

type Row = Record<string, unknown> & { id: string };
const model = async () => (await (await getAuth()).$context).adapter;

/** How the plugin stores a token (SHA-256, base64url): the same value is what we look up. */
const hashed = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64url');

const iso = (d: unknown) => (d ? new Date(d as string | number | Date).toISOString() : null);

// ── Which agent a client is ────────────────────────────────────────────────

/** The hosted Claude apps (claude.ai, Desktop, mobile) all return to this one address. */
const CLAUDE_CALLBACK = /^https:\/\/(claude\.ai|claude\.com)\/api\/mcp\/auth_callback$/;

/**
 * Chat or Claude Code, decided by where the client's registered redirect addresses go, never by the name it gives itself
 * (anyone can register as "Claude"): only a client whose every address is Claude's own hosted callback acts as "claude"
 * (the claude.ai connector, no Claude Code rules). Everything else, Claude Code's loopback callback and any other app,
 * is "claude-code": the stricter rules of lib/mcp/policy.ts (call and deletion limits, dry runs, notices).
 */
export function agentForRedirects(uris: unknown): Agent {
  const list = Array.isArray(uris) ? uris.map(String) : [];
  return list.length > 0 && list.every(u => CLAUDE_CALLBACK.test(u)) ? 'claude' : 'claude-code';
}

/** The name an app gave itself, made safe to show and to store in history: plain text, one line, 60 characters. */
export function cleanName(n: unknown): string {
  const s = typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return s || 'Unnamed app';
}

type ClientInfo = { agent: Agent; name: string; disabled: boolean; at: number };
const clients = new Map<string, ClientInfo>();
const CLIENT_TTL_MS = 30_000;

async function clientInfo(clientId: string): Promise<ClientInfo | null> {
  const hit = clients.get(clientId);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit;
  const c = await (await model()).findOne<Row>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
  if (!c) return null;
  const info: ClientInfo = { agent: agentForRedirects(c.redirectUris), name: cleanName(c.name), disabled: !!c.disabled, at: Date.now() };
  if (clients.size > 500) clients.clear();
  clients.set(clientId, info);
  return info;
}

// ── The resource side: /api/mcp ────────────────────────────────────────────

/**
 * The caller for an OAuth access token, or null. The token must exist (stored hashed), be unexpired and unrevoked, carry
 * the workos scope and be issued for this MCP address; its client must exist and be enabled; and the person must still
 * be a member of the organization they approved it for. Acts exactly like their Claude key: same scope and policy.
 */
export async function callerFromOAuthToken(token: string | null | undefined): Promise<Caller | null> {
  if (!token || !token.startsWith(OAUTH_ACCESS_PREFIX) || token.length < 20 || token.length > 200) return null;
  const adapter = await model();
  const row = await adapter.findOne<Row>({ model: 'oauthAccessToken', where: [{ field: 'token', value: hashed(token.slice(OAUTH_ACCESS_PREFIX.length)) }] });
  if (!row || row.revoked) return null;
  if (!row.expiresAt || new Date(row.expiresAt as string).getTime() <= Date.now()) return null;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
  const resources = Array.isArray(row.resources) ? (row.resources as string[]) : [];
  const userId = row.userId ? String(row.userId) : null;
  const orgId = typeof row.referenceId === 'string' ? row.referenceId : null;
  if (!userId || !orgId || !scopes.includes(OAUTH_SCOPE) || !resources.includes(mcpResource())) return null;
  const client = await clientInfo(String(row.clientId));
  if (!client || client.disabled) return null;
  const role = await roleOf(userId, orgId);
  if (!role) return null;
  const { email, name } = await personOf(userId);
  const tz = await timezoneOf({ userId, orgId });
  // One stable id per (app, person): the call limits and confirm tokens of lib/mcp/policy.ts must survive a refresh.
  return { userId, orgId, role, email, name, tz, via: 'key', key: { id: `oauth_${row.clientId}_${userId}`, name: client.name, agent: client.agent } };
}

// ── Settings › Connections ─────────────────────────────────────────────────

export type AuthorizedApp = { clientId: string; name: string; agent: Agent; since: string; lastUsedAt: string | null };

/** The apps this person approved for the organization they are in, newest first. */
export async function listAuthorizedApps(c: Caller): Promise<AuthorizedApp[]> {
  const adapter = await model();
  const consents = await adapter.findMany<Row>({ model: 'oauthConsent', where: [{ field: 'userId', value: c.userId }, { field: 'referenceId', value: c.orgId }] });
  const out: AuthorizedApp[] = [];
  for (const k of consents ?? []) {
    const info = await clientInfo(String(k.clientId));
    if (!info) continue;
    const tokens = await adapter.findMany<Row>({
      model: 'oauthAccessToken',
      where: [{ field: 'clientId', value: String(k.clientId) }, { field: 'userId', value: c.userId }, { field: 'referenceId', value: c.orgId }],
      sortBy: { field: 'createdAt', direction: 'desc' },
      limit: 1,
    });
    out.push({ clientId: String(k.clientId), name: info.name, agent: info.agent, since: iso(k.createdAt)!, lastUsedAt: iso(tokens?.[0]?.createdAt) });
  }
  return out.sort((a, b) => (b.lastUsedAt ?? b.since).localeCompare(a.lastUsedAt ?? a.since));
}

/** Revokes one app for this person in this organization: its approval and every access and refresh token. Returns how many access tokens went. */
export async function revokeAuthorizedApp(c: Caller, clientId: string): Promise<number> {
  if (c.via !== 'session') throw new SafeError('Apps are revoked by a signed-in person.');
  const id = String(clientId ?? '');
  const gone = () => new SafeError('That app is already revoked or does not exist.');
  if (!id || id.length > 200) throw gone();
  const adapter = await model();
  const consent = await adapter.findOne<Row>({ model: 'oauthConsent', where: [{ field: 'clientId', value: id }, { field: 'userId', value: c.userId }, { field: 'referenceId', value: c.orgId }] });
  if (!consent) throw gone();
  return dropOAuth(c.userId, c.orgId, id);
}

/**
 * Deletes a person's OAuth approvals and tokens: for one organization (they left it), for one client there, or, with no
 * organization, everything they have (their password was reset). Returns how many access tokens went.
 */
export async function dropOAuth(userId: string, orgId: string | null, clientId?: string): Promise<number> {
  const adapter = await model();
  const where = [{ field: 'userId', value: userId }, ...(orgId ? [{ field: 'referenceId', value: orgId }] : []), ...(clientId ? [{ field: 'clientId', value: clientId }] : [])];
  const access = (await adapter.findMany<Row>({ model: 'oauthAccessToken', where })) ?? [];
  await adapter.deleteMany({ model: 'oauthAccessToken', where });
  await adapter.deleteMany({ model: 'oauthRefreshToken', where });
  await adapter.deleteMany({ model: 'oauthConsent', where });
  // Their link to Delpat OS (lib/delpat-os.ts) goes with the rest of what they approved: when they leave an organization,
  // and on a password reset or change. Not when one app is revoked. Last, and never able to stop the revocations above.
  if (!clientId) {
    try {
      await (await import('./delpat-os')).dropLinks(userId, orgId);
    } catch (e) {
      console.error('dropping Delpat OS links failed:', e instanceof Error ? e.name : 'error');
    }
  }
  return access.length;
}

// ── The consent screen ─────────────────────────────────────────────────────

export type ConsentView =
  | { ok: false }
  | { ok: true; oauthQuery: string; clientName: string; agent: Agent; redirectHost: string; loopbackOnly: boolean; lookalike: boolean; ageMinutes: number | null; orgName: string; offline: boolean };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * What /oauth/consent shows, from the signed authorization request Better Auth put in the address. A request whose
 * signature or time is wrong, or whose app is unknown or disabled, shows nothing (ok: false). The text an app chose for
 * itself is plain text, labelled as the app's own claim by the page. The same signed query goes back to Better Auth with the
 * Allow or Deny, which checks it again.
 */
export async function consentView(search: URLSearchParams, c: Caller): Promise<ConsentView> {
  const names = new Set(search.getAll('ba_param'));
  if (!search.has('sig') || !names.size) return { ok: false };
  const signed = new URLSearchParams();
  for (const [k, v] of search.entries()) if (k === 'sig' || k === 'ba_param' || names.has(k)) signed.append(k, v);
  const secret = authSecret();
  if (!secret || !(await verifyOAuthQueryParams(signed.toString(), secret))) return { ok: false };
  const clientId = signed.get('client_id');
  const redirect = signed.get('redirect_uri');
  if (!clientId || !redirect) return { ok: false };
  const client = await clientInfo(clientId);
  if (!client || client.disabled) return { ok: false };
  let host: URL;
  try {
    host = new URL(redirect);
  } catch {
    return { ok: false };
  }
  const org = await (await model()).findOne<Row>({ model: 'organization', where: [{ field: 'id', value: c.orgId }] });
  const row = await (await model()).findOne<Row>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
  const uris = Array.isArray(row?.redirectUris) ? (row.redirectUris as string[]) : [];
  const loopbackOnly = uris.length > 0 && uris.every(u => {
    try {
      return LOOPBACK.has(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return {
    ok: true,
    oauthQuery: signed.toString(),
    clientName: client.name,
    agent: client.agent,
    redirectHost: host.host,
    loopbackOnly,
    // Calls itself Claude (or Anthropic) but is neither Claude's hosted connector nor a program on this computer.
    lookalike: client.agent !== 'claude' && !loopbackOnly && /claude|anthropic|delpat|work\s*os/i.test(client.name),
    // Newly registered clients are the ones a phishing link would use: the screen says how new it is.
    ageMinutes: row?.createdAt && Date.now() - new Date(row.createdAt as string).getTime() < 86_400_000 ? Math.max(0, Math.round((Date.now() - new Date(row.createdAt as string).getTime()) / 60_000)) : null,
    orgName: String(org?.name ?? 'your organization'),
    offline: (signed.get('scope') ?? '').split(' ').includes('offline_access'),
  };
}

// ── Housekeeping ───────────────────────────────────────────────────────────

let lastPrune = 0;
/** Registration is open, so clients that nobody approved within UNUSED_CLIENT_HOURS are deleted (at most every 10 minutes, on a registration). */
export async function pruneUnusedClients(): Promise<number> {
  if (Date.now() - lastPrune < Number(process.env.OAUTH_PRUNE_EVERY_MS ?? 600_000)) return 0;
  lastPrune = Date.now();
  const adapter = await model();
  const cutoff = new Date(Date.now() - UNUSED_CLIENT_HOURS * 3_600_000);
  const old = (await adapter.findMany<Row>({ model: 'oauthClient', where: [{ field: 'createdAt', operator: 'lt', value: cutoff }], limit: 500 })) ?? [];
  if (!old.length) return 0;
  const used = new Set(((await adapter.findMany<Row>({ model: 'oauthConsent', where: [{ field: 'clientId', operator: 'in', value: old.map(c => String(c.clientId)) }] })) ?? []).map(k => String(k.clientId)));
  const gone = old.filter(c => !used.has(String(c.clientId)));
  for (const c of gone) {
    await adapter.deleteMany({ model: 'oauthClientResource', where: [{ field: 'clientId', value: String(c.clientId) }] });
    await adapter.delete({ model: 'oauthClient', where: [{ field: 'clientId', value: String(c.clientId) }] });
    clients.delete(String(c.clientId));
  }
  return gone.length;
}

/** The plugin seeds the MCP resource row once at start-up; make it again if the row is gone (a restored or emptied database). */
export async function ensureResource(): Promise<void> {
  const adapter = await model();
  const identifier = mcpResource();
  if (await adapter.findOne<Row>({ model: 'oauthResource', where: [{ field: 'identifier', value: identifier }] })) return;
  const now = new Date();
  await adapter.create({ model: 'oauthResource', data: { identifier, name: 'Work OS MCP', allowedScopes: [OAUTH_SCOPE, 'offline_access'], createdAt: now, updatedAt: now } });
}
