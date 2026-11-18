import 'server-only';
import { cache } from 'react';
import { todayStr } from './dates';
import { simulatedStampsAllowed } from './cron-at';
import { mailConfigured } from './mail/client';
import { intakeConfig } from './intake';
import { getUserSetting, setUserSetting, type Scope } from './scope';
import { activeBadges, entriesFor, isRecent, isWhatsNewDay, isWhatsNewId, recentUnseen, WHATS_NEW, type BadgePlace, type WhatsNewEntry } from './whats-new';

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

/** The entries this Work OS shows (Mail and the report intake only where they are set up). */
export function whatsNewEntries(): WhatsNewEntry[] {
  const intake = intakeConfig();
  // The reports land in one project the server names; "Try it" opens it (the door still decides who may read it).
  return entriesFor({ mail: mailConfigured(), intake: !!intake }).map(e => (e.requires === 'intake' && intake ? { ...e, href: `/projects/${encodeURIComponent(intake.projectId)}?tab=tasks` } : e));
}

// One read per request: the layout, Today and the Menu all ask.
const seenOf = cache(async (userId: string, orgId: string): Promise<Set<string>> => {
  const v = (await getUserSetting({ userId, orgId }, 'profile'))?.whatsNewSeen;
  return new Set(Array.isArray(v) ? v.filter(isWhatsNewId) : []);
});

export const seenIds = (s: Scope): Promise<Set<string>> => seenOf(s.userId, s.orgId);

export type WhatsNewState = { today: string; entries: WhatsNewEntry[]; seen: Set<string>; unseen: WhatsNewEntry[]; badges: BadgePlace[] };

/** Everything the nav, Today and the page need for this person. Reads nothing while no entry is new. */
export async function whatsNewState(s: Scope & { tz: string }): Promise<WhatsNewState> {
  const today = whatsNewToday(s.tz);
  const entries = whatsNewEntries();
  const seen = entries.some(e => isRecent(e, today)) ? await seenIds(s).catch(() => new Set<string>()) : new Set<string>();
  return { today, entries, seen, unseen: recentUnseen(entries, seen, today), badges: activeBadges(entries, today) };
}

/** Mark one entry, or every entry, as seen for this person. Unknown ids are ignored. */
export async function markWhatsNewSeen(s: Scope, id?: string): Promise<void> {
  const v = (await getUserSetting(s, 'profile'))?.whatsNewSeen;
  const seen = new Set(Array.isArray(v) ? v.filter(isWhatsNewId) : []);
  if (id === undefined) for (const e of WHATS_NEW) seen.add(e.id);
  else if (isWhatsNewId(id)) seen.add(id);
  else return;
  await setUserSetting(s, 'profile', { whatsNewSeen: [...seen] });
}
