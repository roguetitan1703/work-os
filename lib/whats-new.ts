// What's new in Work OS: one list, newest first. Today's "New in Work OS" card, the /whats-new page, the nav dot and the
// small "New" badges all read it (docs/HANDOVER.md "What's new").
//
// Each new feature adds its own entry here in its own change (and a `badge` key where it lives), once it is merged.
// Do not add entries for work still being built elsewhere.
//
// Client-safe: no server imports. What a person has seen is server-side (lib/whats-new-seen.ts).

export type WhatsNewEntry = {
  /** Stable slug; stored in each person's seen list, so never rename one. */
  id: string;
  /** The day it went live (YYYY-MM-DD). */
  date: string;
  /** At most 50 characters. */
  title: string;
  /** One sentence, plain words. */
  line: string;
  /** Where to try it: an in-app path. */
  href: string;
  /** Where a small "New" badge goes for BADGE_DAYS (see BADGE_PLACES). */
  badge?: BadgePlace;
  /** Only on a Work OS that has this set up. */
  requires?: 'mail';
};

/** Every place a "New" badge can sit. Add a place here and render `<NewBadge>` there. */
export const BADGE_PLACES = {
  'nav:needs': 'The Needs row in the sidebar and the phone Menu',
  'claude:workers': 'The Workers tab on the Claude page',
  'settings:mail': 'The Mail row in Settings › Connections',
} as const;
export type BadgePlace = keyof typeof BADGE_PLACES;

/** Today shows unseen entries up to this many days after their date. */
export const TODAY_DAYS = 30;
/** A "New" badge shows this many days, counting the entry's own date. */
export const BADGE_DAYS = 14;

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: 'mail',
    date: '2026-11-18',
    title: 'Mail in Claude',
    line: 'Claude reads, sorts and drafts your mail through your own Mailloom mailbox.',
    href: '/settings?section=connections',
    badge: 'settings:mail',
    requires: 'mail',
  },
  {
    id: 'needs',
    date: '2026-11-15',
    title: 'Needs',
    line: 'One list of what waits on you. Answer with a tap.',
    href: '/needs',
    badge: 'nav:needs',
  },
  {
    id: 'state',
    date: '2026-11-15',
    title: 'Project State',
    line: "Each project's Now, Next and Later. A new Claude session picks up where the last one stopped.",
    href: '/projects',
  },
  {
    id: 'workers',
    date: '2026-11-15',
    title: 'Workers',
    line: 'Who, and which agent, is working on what right now.',
    href: '/claude?tab=workers',
    badge: 'claude:workers',
  },
  {
    id: 'results',
    date: '2026-11-15',
    title: 'Results and review',
    line: 'Work an agent finishes comes to you to accept or send back.',
    href: '/today',
  },
];

const DAY_MS = 86_400_000;
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
/** Whole days from `date` to `today` (both YYYY-MM-DD); negative when `date` is later. */
export function daysSince(date: string, today: string): number {
  return Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / DAY_MS);
}

/** The entries for this Work OS (drops those needing something it has not set up). */
export function entriesFor(has: { mail: boolean }): WhatsNewEntry[] {
  return WHATS_NEW.filter(e => e.requires !== 'mail' || has.mail);
}

/** Unseen entries recent enough for Today and the nav dot, newest first. */
export function recentUnseen(entries: readonly WhatsNewEntry[], seen: ReadonlySet<string>, today: string): WhatsNewEntry[] {
  return entries.filter(e => !seen.has(e.id) && daysSince(e.date, today) <= TODAY_DAYS);
}

/** Badge places that are "New" today. */
export function activeBadges(entries: readonly WhatsNewEntry[], today: string): BadgePlace[] {
  return entries.filter(e => e.badge && daysSince(e.date, today) < BADGE_DAYS).map(e => e.badge!);
}

/** The list grouped by date, newest first (the /whats-new page). */
export function byDate(entries: readonly WhatsNewEntry[]): { date: string; entries: WhatsNewEntry[] }[] {
  const out: { date: string; entries: WhatsNewEntry[] }[] = [];
  for (const e of [...entries].sort((a, b) => b.date.localeCompare(a.date))) {
    const last = out[out.length - 1];
    if (last?.date === e.date) last.entries.push(e);
    else out.push({ date: e.date, entries: [e] });
  }
  return out;
}

export const isWhatsNewId = (id: unknown): id is string => typeof id === 'string' && WHATS_NEW.some(e => e.id === id);
export { isDay as isWhatsNewDay };
