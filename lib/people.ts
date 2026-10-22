import 'server-only';
import { getDb } from './db';
import { idIn } from './auth-server';
import type { Scope } from './scope';

// Who is in an organization, read from Better Auth's own collections (member, user, organization). Used for names in
// history ("Ana", "Claude Code · Ana"), the alerts cron (every membership) and Discord (a linked account must still be a member).

const TTL_MS = 60_000;
// On globalThis so a member change clears every bundle's copy in this process (forgetMembers).
const gNames = globalThis as unknown as { __workosMemberNames?: Map<string, { at: number; map: Record<string, string> }> };
const names = (gNames.__workosMemberNames ??= new Map());

/** Forget the cached member list of an organization (after an invitation is accepted or a member removed). */
export function forgetMembers(orgId: string): void {
  names.delete(orgId);
}

/** userId → display name for every member of the organization (cached a minute per process). */
export async function memberNames(orgId: string): Promise<Record<string, string>> {
  const hit = names.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;
  const db = await getDb();
  const members = await db.collection('member').find({ organizationId: idIn(orgId) }, { projection: { userId: 1 } }).toArray();
  const users = await db.collection('user').find({ _id: { $in: members.map(m => m.userId) } }, { projection: { name: 1, email: 1 } }).toArray();
  const map: Record<string, string> = {}; // a plain object (pages pass it to the client): look keys up with Object.hasOwn
  for (const u of users) map[String(u._id)] = String(u.name || u.email || 'Someone');
  if (names.size > 200) names.clear();
  names.set(orgId, { at: Date.now(), map });
  return map;
}

/** Is userId a member of orgId (any role)? */
export async function isMember(orgId: string, userId: string): Promise<boolean> {
  return Object.hasOwn(await memberNames(orgId), userId);
}

/** Every (user, organization) membership: the alerts cron runs once per person with their own settings. */
export async function allMemberships(): Promise<Scope[]> {
  const db = await getDb();
  const ms = await db.collection('member').find({}, { projection: { userId: 1, organizationId: 1 } }).sort({ createdAt: 1 }).toArray();
  return ms.map(m => ({ userId: String(m.userId), orgId: String(m.organizationId) }));
}

/**
 * A member of the organization by user id or email (MCP args such as waiting_on and assignee), or null. Someone not in
 * the cached list is looked up in the database (they may have joined in the last minute).
 */
export async function findMember(orgId: string, idOrEmail: string): Promise<string | null> {
  const v = idOrEmail.trim();
  if (!v) return null;
  if (Object.hasOwn(await memberNames(orgId), v)) return v;
  const db = await getDb();
  let userId = v;
  if (v.includes('@')) {
    const u = await db.collection('user').findOne({ email: v.toLowerCase() }, { projection: { _id: 1 } });
    if (!u) return null;
    userId = String(u._id);
    if (Object.hasOwn(await memberNames(orgId), userId)) return userId;
  } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return null;
  if (!(await db.collection('member').findOne({ organizationId: idIn(orgId), userId: idIn(userId) }, { projection: { _id: 1 } }))) return null;
  forgetMembers(orgId);
  return userId;
}

/** The first organization (by creation): data from before organizations belongs to it (old note files). */
export async function firstOrgId(): Promise<string | null> {
  const db = await getDb();
  const org = await db.collection('organization').find({}, { projection: { _id: 1 } }).sort({ createdAt: 1 }).limit(1).next();
  return org ? String(org._id) : null;
}
