import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { getDb } from './db';
import { SafeError, bearerToken } from './auth';
import { API_KEY_PREFIX, getAuth, idIn, ROLES, type Role } from './auth-server';
import { requestContext, runWithRequestContext } from './request-context';

// Who is calling (docs/auth.md). Every server action, API route and page that needs to know asks here; proxy.ts only
// lets signed-in requests through, and each handler checks again with these helpers.
//
//   getCaller()              the signed-in user of this request (session cookie), or null
//   requireCaller(...roles)  same, or throws NotSignedIn / NotAllowed
//   callerFromRequest(req)   route handlers: session cookie, else a Work OS API key in the Authorization/X-API-Key header
//   verifyKey(token)         an API key alone (the MCP route)
//
// orgId is the session's active organization (set at sign-in to the user's oldest membership). Data is not yet
// scoped by organization (phase 2 of docs/multi-user.md); the caller is made available everywhere so it can be.

export type Agent = 'claude' | 'claude-code';
export type Caller = {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  name: string;
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

// Role per (user, organization), kept briefly in memory: a role change shows within a minute.
const ROLE_TTL_MS = 60_000;
const roles = new Map<string, { role: Role | null; at: number }>();

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

/** Forget cached roles (after a role change or a member removal in this process). */
export function forgetRoles(): void {
  roles.clear();
}

async function firstOrg(userId: string): Promise<string | null> {
  const db = await getDb();
  const m = await db.collection('member').find({ userId: idIn(userId) }).sort({ createdAt: 1 }).limit(1).next();
  return m ? String(m.organizationId) : null;
}

/** The signed-in caller for these request headers (session cookie, cookie cache first), or null. */
export async function callerFromHeaders(h: Headers): Promise<Caller | null> {
  const auth = await getAuth();
  const s = await auth.api.getSession({ headers: h }).catch(() => null);
  if (!s?.user) return null;
  const userId = String(s.user.id);
  const orgId = (s.session as { activeOrganizationId?: string | null }).activeOrganizationId || (await firstOrg(userId));
  if (!orgId) return null; // an account with no organization can't use the app
  const role = await roleIn(userId, String(orgId));
  if (!role) return null;
  return { userId, orgId: String(orgId), role, email: s.user.email, name: s.user.name, via: 'session' };
}

/** The signed-in caller of the current request (server components, server actions, route handlers), or null. */
export const getCaller = cache(async (): Promise<Caller | null> => callerFromHeaders(await headers()));

/** The signed-in caller, or throws NotSignedIn; with roles, throws NotAllowed unless the caller has one of them. */
export async function requireCaller(...allowed: Role[]): Promise<Caller> {
  const c = await getCaller();
  if (!c) throw new NotSignedIn();
  if (allowed.length && !allowed.includes(c.role)) throw new NotAllowed();
  return c;
}

/** A Work OS API key (Authorization: Bearer / X-API-Key), checked by Better Auth; null when invalid, disabled or revoked. */
export async function verifyKey(token: string | null | undefined): Promise<Caller | null> {
  if (!token || !token.startsWith(API_KEY_PREFIX) || token.length < 40 || token.length > 120) return null;
  const auth = await getAuth();
  const r = await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
  if (!r?.valid || !r.key) return null;
  const meta = (r.key.metadata ?? {}) as { agent?: unknown; orgId?: unknown };
  const agent: Agent | null = meta.agent === 'claude' || meta.agent === 'claude-code' ? meta.agent : null;
  const orgId = typeof meta.orgId === 'string' ? meta.orgId : null;
  if (!agent || !orgId) return null;
  const userId = String(r.key.referenceId);
  // The key's owner must still be a member of the key's organization.
  const role = await roleIn(userId, orgId);
  if (!role) return null;
  return { userId, orgId, role, email: '', name: '', via: 'key', key: { id: String(r.key.id), name: r.key.name ?? '', agent } };
}

/** Route handlers: the session cookie, else an API key header. */
export async function callerFromRequest(req: Request): Promise<Caller | null> {
  return (await callerFromHeaders(req.headers)) ?? (await verifyKey(bearerToken(req)));
}

/** Runs fn with the caller's user id in the request context, so history entries record it (`actorUserId`). */
export function withCaller<T>(c: Caller, fn: () => T): T {
  return runWithRequestContext({ ...requestContext(), userId: c.userId }, fn);
}

/** requireCaller + withCaller: for server actions that have no wrapper of their own. */
export async function asCaller<T>(fn: (c: Caller) => Promise<T>, ...allowed: Role[]): Promise<T> {
  const c = await requireCaller(...allowed);
  return withCaller(c, () => fn(c));
}
