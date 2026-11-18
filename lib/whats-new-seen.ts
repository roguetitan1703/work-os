import 'server-only';
import { todayStr } from './dates';
import { simulatedStampsAllowed } from './cron-at';
import { mailConfigured } from './mail/client';
import { getUserSetting, setUserSetting, type Scope } from './scope';
import { activeBadges, entriesFor, isWhatsNewDay, isWhatsNewId, recentUnseen, WHATS_NEW, type BadgePlace, type WhatsNewEntry } from './whats-new';

// What each person has seen of lib/whats-new.ts: the ids they dismissed or opened, in their own `profile:<userId>`
// settings (field whatsNewSeen). Only ids from the list are ever stored. Written only by the signed-in person
// (app/(app)/whats-new/actions.ts, session cookie); nothing else reads it.

/**
 * "Today" for the What's new windows: the person's own day. The e2e runner pins it (E2E_WHATS_NEW_TODAY) so the suites
 * do not depend on the real date; that only works on the e2e database, like the cron's ?at= (lib/cron-at.ts).
 */
export function whatsNewToday(tz: string): string {
  const pin = process.env.E2E_WHATS_NEW_TODAY?.trim();
  return pin && isWhatsNewDay(pin) && simulatedStampsAllowed() ? pin : todayStr(tz);
}

/** The entries this Work OS shows (Mail only where Mailloom is set up). */
export const whatsNewEntries = (): WhatsNewEntry[] => entriesFor({ mail: mailConfigured() });

export async function seenIds(s: Scope): Promise<Set<string>> {
  const v = (await getUserSetting(s, 'profile'))?.whatsNewSeen;
  return new Set(Array.isArray(v) ? v.filter(isWhatsNewId) : []);
}

export type WhatsNewState = { today: string; entries: WhatsNewEntry[]; seen: Set<string>; unseen: WhatsNewEntry[]; badges: BadgePlace[] };

/** Everything the nav, Today and the page need for this person. */
export async function whatsNewState(s: Scope & { tz: string }): Promise<WhatsNewState> {
  const today = whatsNewToday(s.tz);
  const entries = whatsNewEntries();
  const seen = await seenIds(s).catch(() => new Set<string>());
  return { today, entries, seen, unseen: recentUnseen(entries, seen, today), badges: activeBadges(entries, today) };
}

/** Mark one entry, or every entry, as seen for this person. Unknown ids are ignored. */
export async function markWhatsNewSeen(s: Scope, id?: string): Promise<void> {
  const seen = await seenIds(s);
  if (id === undefined) for (const e of WHATS_NEW) seen.add(e.id);
  else if (isWhatsNewId(id)) seen.add(id);
  else return;
  await setUserSetting(s, 'profile', { whatsNewSeen: [...seen] });
}
