import 'server-only';
import { createHash, randomInt } from 'node:crypto';
import { DEFAULT_TZ, isTimeZone } from './dates';
import { InputError } from './data/errors';
import { getUserSetting, orgWithSetting, setUserSetting, takeUserSetting, usersWithSetting, type Scope } from './scope';
import { isMember } from './people';
import { orgGuildId, type DiscordLink } from './discord/client';
import './request-context';

// Each person's own settings that are not about one feature (docs/multi-user.md phase 3), in `profile:<userId>`:
//   timezone      IANA zone; what "today" and alert hours mean for them (default APP_TZ, else UTC)
//   quiet hours   quietStart–quietEnd (whole hours in their zone): alerts wait until it ends; equal = none
//   discordId     their linked Discord account: commands act as them, their alert DMs go there
//
// The Discord link is proven, never typed: Settings makes a short code (stored hashed, 10 minutes) and the person
// runs /link <code> on the organization's Discord server; the signed interaction says which Discord account it was.

export type Profile = { timezone: string; quietStart: number; quietEnd: number; discordId: string | null };
export const DEFAULT_QUIET = { start: 23, end: 8 } as const;

const TTL_MS = 60_000;
// On globalThis: route handlers, pages and actions can each load their own copy of this module, and a save in one
// must clear what the others read.
const g = globalThis as unknown as { __workosProfiles?: Map<string, { at: number; p: Profile }> };
const cache = (g.__workosProfiles ??= new Map());
const key = (s: Scope) => `${s.orgId}:${s.userId}`;

const hour = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? (v as number) : d);

/** The person's profile (cached a minute per process; a save here clears it). */
export async function getProfile(s: Scope): Promise<Profile> {
  const hit = cache.get(key(s));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const d = await getUserSetting(s, 'profile');
  const p: Profile = {
    timezone: isTimeZone(d?.timezone) ? d!.timezone! : DEFAULT_TZ,
    quietStart: hour(d?.quietStart, DEFAULT_QUIET.start),
    quietEnd: hour(d?.quietEnd, DEFAULT_QUIET.end),
    discordId: typeof d?.discordId === 'string' && d.discordId ? d.discordId : null,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(key(s), { at: Date.now(), p });
  return p;
}

/** Just the timezone (pages, actions, the cron). */
export async function timezoneOf(s: Scope): Promise<string> {
  return (await getProfile(s)).timezone;
}

export async function saveTimeSettings(s: Scope, input: { timezone: string; quietStart: number; quietEnd: number }): Promise<Profile> {
  if (!isTimeZone(input.timezone)) throw new InputError('Pick a timezone from the list');
  for (const v of [input.quietStart, input.quietEnd]) if (!Number.isInteger(v) || v < 0 || v > 23) throw new InputError('Quiet hours are whole hours, 0 to 23');
  await setUserSetting(s, 'profile', { timezone: input.timezone, quietStart: input.quietStart, quietEnd: input.quietEnd, updatedAt: new Date() });
  cache.delete(key(s));
  return getProfile(s);
}

/** Is this hour (0–23, in the person's zone) inside their quiet hours? */
export function inQuietHours(p: Pick<Profile, 'quietStart' | 'quietEnd'>, h: number): boolean {
  const { quietStart: a, quietEnd: b } = p;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// ── Discord link ────────────────────────────────────────────────────────────

const LINK_TTL_MS = 10 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const hashCode = (code: string) => createHash('sha256').update(`discord-link:${code.trim().toUpperCase()}`).digest('hex');

/** A fresh one-time code for /link (shown once; replaces any earlier one). */
export async function startDiscordLink(s: Scope): Promise<{ code: string; expiresAt: Date }> {
  const code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await setUserSetting(s, 'profile', { discordLink: { hash: hashCode(code), expiresAt } });
  return { code, expiresAt };
}

/**
 * /link <code> from Discord account `discordId` on the server `guildId`: links that account to the person who made the
 * code, in the organization that owns the server. Any earlier link of this Discord account in that organization is
 * moved. Returns the linked person, or null for an unknown or expired code.
 */
export async function finishDiscordLink(guildId: string, discordId: string, code: string): Promise<Scope | null> {
  if (!/^\d{15,22}$/.test(discordId) || !/^[A-Za-z0-9]{6,12}$/.test(code.trim())) return null;
  const orgId = await orgWithSetting('discord', { guildId });
  if (!orgId) return null;
  // Used up in the same step it is found, so two /link calls with one code cannot both succeed.
  const userId = await takeUserSetting(orgId, 'profile', { 'discordLink.hash': hashCode(code), 'discordLink.expiresAt': { $gt: new Date() } }, { discordLink: null });
  if (!userId || !(await isMember(orgId, userId))) return null;
  const s = { userId, orgId };
  for (const other of await usersWithSetting(orgId, 'profile', { discordId })) {
    if (other !== userId) {
      await setUserSetting({ userId: other, orgId }, 'profile', { discordId: null });
      cache.delete(key({ userId: other, orgId }));
    }
  }
  await setUserSetting(s, 'profile', { discordId, discordLink: null, linkedAt: new Date() });
  cache.delete(key(s));
  return s;
}

export async function unlinkDiscord(s: Scope): Promise<void> {
  await setUserSetting(s, 'profile', { discordId: null, discordLink: null });
  cache.delete(key(s));
}

/** The Work OS person a Discord account acts as, in the organization that owns the server; null if not linked (or no longer a member). */
export async function discordUser(guildId: string, discordId: string): Promise<Scope | null> {
  if (!/^\d{15,22}$/.test(guildId) || !/^\d{15,22}$/.test(discordId)) return null;
  const orgId = await orgWithSetting('discord', { guildId });
  if (!orgId) return null;
  for (const userId of await usersWithSetting(orgId, 'profile', { discordId })) if (await isMember(orgId, userId)) return { userId, orgId };
  return null;
}

/** The person's Discord in their organization: its server and their linked account; null when the organization has no server. */
export async function discordLinkOf(s: Scope): Promise<DiscordLink | null> {
  const guildId = await orgGuildId(s.orgId);
  return guildId ? { orgId: s.orgId, guildId, discordId: (await getProfile(s)).discordId } : null;
}
