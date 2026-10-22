import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { getDb } from './db';
import { SafeError, bearerToken } from './auth';
import { API_KEY_PREFIX, getAuth, idIn, ROLES, type Role } from './auth-server';
import { requestContext, runWithRequestContext, setRenderTz } from './request-context';
import { timezoneOf } from './profile';
import type { Scope } from './scope';

// Who is calling (docs/auth.md). Every server action, API route and page that needs to know asks here; proxy.ts only
// lets signed-in requests through, and each handler checks again with these helpers.
//
//   getCaller()              the signed-in user of this request (session cookie), or null
//   requireCaller(...roles)  same, or throws NotSignedIn / NotAllowed
//   callerFromRequest(req)   route handlers: session cookie, else a Work OS API key in the Authorization/X-API-Key header
//   verifyKey(token)         an API key alone (the MCP route)
//
// orgId is the session's active organization (set at sign-in to the user's oldest membership). Every data call takes
// the caller's scope ({ userId, orgId }, requireScope) and reads through lib/scope.ts (docs/multi-user.md "One door").

export type Agent = 'claude' | 'claude-code';
export type Caller = {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  name: string;
  /** Their timezone (lib/profile.ts): what "today" means in this request. */
  tz: string;
  via: 'session' | 'key';
  /** Set when the request came with an API key. */
  key?: { id: string; name: string; agent: Agent };
};

export class NotSignedIn extends SafeError {
  constructor() {
    super('Not signed in.');
  }
}
export class NotAllowed extends SafeError {
  constructor(msg = 'Only an owner or admin can do that.') {
    super(msg);
  }
}

// Role per (user, organization), kept briefly in memory: a role change shows within a minute, at once in this process
// (forgetRoles). On globalThis: route handlers, pages and actions can each load their own copy of this module.
const ROLE_TTL_MS = 60_000;
const gRoles = globalThis as unknown as { __workosRoles?: Map<string, { role: Role | null; at: number }> };
const roles = (gRoles.__workosRoles ??= new Map());

async function roleIn(userId: string, orgId: string): Promise<Role | null> {
  const k = `${userId}:${orgId}`;
  const hit = roles.get(k);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role;
  const db = await getDb();
  const m = await db.collection('member').findOne({ userId: idIn(userId), organizationId: idIn(orgId) }, { projection: { role: 1 } });
  const role = m && (ROLES as readonly string[]).includes(String(m.role)) ? (m.role as Role) : null;
  if (roles.size > 5000) roles.clear();
  roles.set(k, { role, at: Date.now() });
  return role;
}

// The key owner's email and name (operator checks, lib/operator.ts), kept as briefly as roles.
const people = new Map<string, { email: string; name: string; at: number }>();
async function personOf(userId: string): Promise<{ email: string; name: string }> {
  const hit = people.get(userId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit;
  const db = await getDb();
  const u = await db.collection('user').findOne({ _id: idIn(userId) }, { projection: { email: 1, name: 1 } });
  const p = { email: String(u?.email ?? ''), name: String(u?.name ?? ''), at: Date.now() };
  if (people.size > 5000) people.clear();
  people.set(userId, p);
  return p;
}

/** userId's role in orgId, or null when they are not a member (cached like every role check). */
export async function roleOf(userId: string, orgId: string): Promise<Role | null> {
  return roleIn(userId, orgId);
}

/** Forget cached roles (after a role change or a member removal in this process). */
export function forgetRoles(): void {
  roles.clear();
}

async function firstOrg(userId: string): Promise<string | null> {
  const db = await getDb();
  const m = await db.collection('member').find({ userId: idIn(userId) }).sort({ createdAt: 1 }).limit(1).next();
  return m ? String(m.organizationId) : null;
}

/**
 * Could Next run a server action for this request? Next treats a POST as one when it has the `next-action` header
 * (a fetch action) or a form body: `multipart/form-data` (a form post, which picks the action and its bound arguments
 * from `$ACTION_REF_n`/`$ACTION_ID_n` fields) or `application/x-www-form-urlencoded`
 * (next/dist/server/lib/server-action-request-meta.js). The method is not in the headers, so this is a superset: a GET
 * with a form content type reads fresh too, which only costs a read.
 */
function mayBeAction(h: Headers): boolean {
  return h.has('next-action') || /^\s*(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(h.get('content-type') ?? '');
}

/**
 * The signed-in caller for these request headers, or null. Page renders and other reads trust Better Auth's signed
 * cookie cache (up to COOKIE_CACHE_SECONDS old); a possible server action, or `fresh`, reads the session from the
 * database, so a session that signed out or was revoked can no longer change anything (docs/auth.md).
 */
export async function callerFromHeaders(h: Headers, fresh = mayBeAction(h)): Promise<Caller | null> {
  const auth = await getAuth();
  const s = await auth.api.getSession({ headers: h, ...(fresh ? { query: { disableCookieCache: true } } : {}) }).catch(() => null);
  if (!s?.user) return null;
  const userId = String(s.user.id);
  const orgId = (s.session as { activeOrganizationId?: string | null }).activeOrganizationId || (await firstOrg(userId));
  if (!orgId) return null; // an account with no organization can't use the app
  const role = await roleIn(userId, String(orgId));
  if (!role) return null;
  const tz = await timezoneOf({ userId, orgId: String(orgId) });
  return { userId, orgId: String(orgId), role, email: s.user.email, name: s.user.name, tz, via: 'session' };
}

/**
 * The signed-in caller of the current request (server components, server actions, route handlers), or null. In a page
 * render it also sets "today" to the caller's timezone for the rest of the render (lib/request-context.ts).
 */
export const getCaller = cache(async (): Promise<Caller | null> => {
  const c = await callerFromHeaders(await headers());
  if (c) setRenderTz(c.tz);
  return c;
});

/** The signed-in caller, or throws NotSignedIn; with roles, throws NotAllowed unless the caller has one of them. */
export async function requireCaller(...allowed: Role[]): Promise<Caller> {
  const c = await getCaller();
  if (!c) throw new NotSignedIn();
  if (allowed.length && !allowed.includes(c.role)) throw new NotAllowed();
  return c;
}

/**
 * A Work OS API key (Authorization: Bearer / X-API-Key), checked by Better Auth; null when invalid, disabled or revoked.
 * agents: which kinds to accept (default both). Outside /api/mcp only Claude chat keys are accepted, as MCP_TOKEN was:
 * Claude Code keys open the MCP endpoint and nothing else.
 */
export async function verifyKey(token: string | null | undefined, agents: Agent[] = ['claude', 'claude-code']): Promise<Caller | null> {
  if (!token || !token.startsWith(API_KEY_PREFIX) || token.length < 40 || token.length > 120) return null;
  const auth = await getAuth();
  const r = await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
  if (!r?.valid || !r.key) return null;
  const meta = (r.key.metadata ?? {}) as { agent?: unknown; orgId?: unknown };
  const agent: Agent | null = meta.agent === 'claude' || meta.agent === 'claude-code' ? meta.agent : null;
  const orgId = typeof meta.orgId === 'string' ? meta.orgId : null;
  if (!agent || !orgId || !agents.includes(agent)) return null;
  const userId = String(r.key.referenceId);
  // The key's owner must still be a member of the key's organization.
  const role = await roleIn(userId, orgId);
  if (!role) return null;
  const { email, name } = await personOf(userId);
  const tz = await timezoneOf({ userId, orgId });
  return { userId, orgId, role, email, name, tz, via: 'key', key: { id: String(r.key.id), name: r.key.name ?? '', agent } };
}

/** Route handlers other than /api/mcp: the session cookie, else a Claude chat key header (not a Claude Code key). */
export async function callerFromRequest(req: Request): Promise<Caller | null> {
  return (await callerFromHeaders(req.headers, req.method !== 'GET' && req.method !== 'HEAD')) ?? (await verifyKey(bearerToken(req), ['claude']));
}

/** Runs fn with the caller's user id (history entries record it) and timezone ("today") in the request context. */
export function withCaller<T>(c: Caller, fn: () => T): T {
  return runWithRequestContext({ ...requestContext(), userId: c.userId, tz: c.tz }, fn);
}

/** requireCaller + withCaller: for server actions that have no wrapper of their own. */
export async function asCaller<T>(fn: (c: Caller) => Promise<T>, ...allowed: Role[]): Promise<T> {
  const c = await requireCaller(...allowed);
  return withCaller(c, () => fn(c));
}

/** The signed-in caller's data scope (lib/scope.ts), or throws NotSignedIn. Pages and actions pass it to lib/data. */
export async function requireScope(): Promise<Scope> {
  const c = await requireCaller();
  return { userId: c.userId, orgId: c.orgId };
}
