import 'server-only';
import { DEFAULT_TZ, isTimeZone } from './dates';
import { InputError } from './data/errors';
import { getUserSetting, orgWithSetting, setUserSetting, usersWithSetting, type Scope } from './scope';
import { isMember } from './people';
import { orgGuildId, type DiscordLink } from './discord/client';
import './request-context';

// Each person's own settings that are not about one feature (docs/multi-user.md phase 3), in `profile:<userId>`:
//   timezone      IANA zone; what "today" and alert hours mean for them (default APP_TZ, else UTC)
//   quiet hours   quietStart–quietEnd (whole hours in their zone): alerts wait until it ends; equal = none
//   digestHour    the hour their daily digest is sent (default 9)
//   discordId     their linked Discord account: what they mark or press there is theirs, their reel and day-old Need DMs go there
//   discordCardHidden  they hid the Connect Discord card on Today
//
// The Discord link is proven, never typed: Connect Discord (lib/discord/connect.ts) signs them in at Discord.

export type Profile = { timezone: string; quietStart: number; quietEnd: number; /** The hour their daily digest is sent (alerts kind `digest`). */ digestHour: number; discordId: string | null; /** Hid the Connect Discord card on Today. */ discordCardHidden: boolean };
/**
 * Quiet hours for someone who has not set their own: 23:00–08:00, or DEFAULT_QUIET_HOURS ("22-7", or "none"; the e2e
 * runner sets none so alert suites pass at any hour).
 */
export const DEFAULT_QUIET = ((): { start: number; end: number } => {
  const v = process.env.DEFAULT_QUIET_HOURS?.trim();
  if (v === 'none') return { start: 0, end: 0 };
  const m = v?.match(/^(d{1,2})-(d{1,2})$/);
  return m && +m[1] <= 23 && +m[2] <= 23 ? { start: +m[1], end: +m[2] } : { start: 23, end: 8 };
})();

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
    digestHour: hour(d?.digestHour, 9),
    discordId: typeof d?.discordId === 'string' && d.discordId ? d.discordId : null,
    discordCardHidden: d?.discordCardHidden === true,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(key(s), { at: Date.now(), p });
  return p;
}

/** Just the timezone (pages, actions, the cron). */
export async function timezoneOf(s: Scope): Promise<string> {
  return (await getProfile(s)).timezone;
}

export async function saveTimeSettings(s: Scope, input: { timezone: string; quietStart: number; quietEnd: number; digestHour?: number }): Promise<Profile> {
  if (!isTimeZone(input.timezone)) throw new InputError('Pick a timezone from the list');
  for (const v of [input.quietStart, input.quietEnd]) if (!Number.isInteger(v) || v < 0 || v > 23) throw new InputError('Quiet hours are whole hours, 0 to 23');
  if (input.digestHour !== undefined && (!Number.isInteger(input.digestHour) || input.digestHour < 0 || input.digestHour > 23)) throw new InputError('The digest hour is a whole hour, 0 to 23');
  await setUserSetting(s, 'profile', { timezone: input.timezone, quietStart: input.quietStart, quietEnd: input.quietEnd, ...(input.digestHour !== undefined ? { digestHour: input.digestHour } : {}), updatedAt: new Date() });
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
// Made only by Connect Discord (lib/discord/connect.ts: Discord's own sign-in proves the account); there is no code to type.

/**
 * Links the Discord account `discordId` to this person, in their organization. One Discord account belongs to one person
 * there: any earlier link of it to someone else is moved away.
 */
export async function linkDiscordAccount(s: Scope, discordId: string): Promise<void> {
  if (!/^\d{15,22}$/.test(discordId)) throw new InputError('That is not a Discord account id');
  for (const other of await usersWithSetting(s.orgId, 'profile', { discordId })) {
    if (other !== s.userId) {
      await setUserSetting({ userId: other, orgId: s.orgId }, 'profile', { discordId: null });
      cache.delete(key({ userId: other, orgId: s.orgId }));
    }
  }
  await setUserSetting(s, 'profile', { discordId, discordConnect: null, discordCardHidden: false, linkedAt: new Date() });
  cache.delete(key(s));
}

export async function unlinkDiscord(s: Scope): Promise<void> {
  await setUserSetting(s, 'profile', { discordId: null, discordConnect: null });
  cache.delete(key(s));
}

/** The person hides the Connect Discord card on Today; Settings still has the button. */
export async function hideDiscordCard(s: Scope): Promise<void> {
  await setUserSetting(s, 'profile', { discordCardHidden: true });
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
