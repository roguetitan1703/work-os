import 'server-only';
import { getDb } from './db';
import { idIn } from './auth-server';
import { discordConfig } from './discord/client';
import type { Scope } from './scope';

// Who is in an organization, read from Better Auth's own collections (member, user, organization). Used for names in
// history ("Ana", "Claude Code · Ana"), the alerts cron (every membership) and the Discord link.

const TTL_MS = 60_000;
const names = new Map<string, { at: number; map: Record<string, string> }>();

/** userId → display name for every member of the organization (cached a minute per process). */
export async function memberNames(orgId: string): Promise<Record<string, string>> {
  const hit = names.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;
  const db = await getDb();
  const members = await db.collection('member').find({ organizationId: idIn(orgId) }, { projection: { userId: 1 } }).toArray();
  const users = await db.collection('user').find({ _id: { $in: members.map(m => m.userId) } }, { projection: { name: 1, email: 1 } }).toArray();
  const map: Record<string, string> = {};
  for (const u of users) map[String(u._id)] = String(u.name || u.email || 'Someone');
  if (names.size > 200) names.clear();
  names.set(orgId, { at: Date.now(), map });
  return map;
}

/** Is userId a member of orgId (any role)? */
export async function isMember(orgId: string, userId: string): Promise<boolean> {
  return userId in (await memberNames(orgId));
}

/** Every (user, organization) membership: the alerts cron runs once per person with their own settings. */
export async function allMemberships(): Promise<Scope[]> {
  const db = await getDb();
  const ms = await db.collection('member').find({}, { projection: { userId: 1, organizationId: 1 } }).sort({ createdAt: 1 }).toArray();
  return ms.map(m => ({ userId: String(m.userId), orgId: String(m.organizationId) }));
}

let discordCache: { at: number; scope: Scope | null } | null = null;

/**
 * The Work OS user the Discord bot acts for (docs/multi-user.md: phase 3 links each person's Discord id; until then
 * DISCORD_OWNER_ID maps to the owner of the first organization). null when Discord is not configured.
 */
export async function discordScope(): Promise<Scope | null> {
  if (!discordConfig()) return null;
  if (discordCache && Date.now() - discordCache.at < TTL_MS) return discordCache.scope;
  const db = await getDb();
  const org = await db.collection('organization').find({}, { projection: { _id: 1 } }).sort({ createdAt: 1 }).limit(1).next();
  const owner = org ? await db.collection('member').find({ organizationId: idIn(String(org._id)), role: 'owner' }).sort({ createdAt: 1 }).limit(1).next() : null;
  const scope = org && owner ? { userId: String(owner.userId), orgId: String(org._id) } : null;
  discordCache = { at: Date.now(), scope };
  return scope;
}

/** Is this person the one the Discord bot is linked to? */
export async function isDiscordUser(s: Scope): Promise<boolean> {
  const d = await discordScope();
  return !!d && d.userId === s.userId && d.orgId === s.orgId;
}

/** A member of the organization by user id or email (MCP args such as waiting_on), or null. */
export async function findMember(orgId: string, idOrEmail: string): Promise<string | null> {
  const v = idOrEmail.trim();
  if (!v) return null;
  if (v in (await memberNames(orgId))) return v;
  if (!v.includes('@')) return null;
  const db = await getDb();
  const u = await db.collection('user').findOne({ email: v.toLowerCase() }, { projection: { _id: 1 } });
  return u && (await isMember(orgId, String(u._id))) ? String(u._id) : null;
}

/** The first organization (by creation): data from before organizations belongs to it (old note files). */
export async function firstOrgId(): Promise<string | null> {
  const db = await getDb();
  const org = await db.collection('organization').find({}, { projection: { _id: 1 } }).sort({ createdAt: 1 }).limit(1).next();
  return org ? String(org._id) : null;
}
