// What's new in Work OS: one list, newest first. Today's "New in Work OS" card, the /whats-new page, the nav dot and the
// small "New" badges all read it (docs/HANDOVER.md "What's new").
//
// Shipping a user-facing feature = adding one entry here, in the same change (AGENTS.md "Adding or changing UI"), and a
// `badge` when the feature has its own entry in the sidebar. Do not add entries for work still being
// built elsewhere.
//
// Client-safe: no server imports. What a person has seen is server-side (lib/whats-new-seen.ts).

export type WhatsNewEntry = {
  /** Stable slug; stored in each person's seen list, so never rename one. */
  id: string;
  /** The day it went live (YYYY-MM-DD). */
  date: string;
  /** At most 50 characters. */
  title: string;
  /** One sentence, plain words: what it does for you. */
  line: string;
  /** Where to find it, as a person would say it ("Menu › Needs on the phone, Needs in the sidebar"). */
  where: string;
  /** Where "Try it" goes: an in-app path. */
  href: string;
  /** Where a small "New" badge goes for NEW_DAYS (see BADGE_PLACES). */
  badge?: BadgePlace;
  /** Only on a Work OS that has this set up: `mail` Mailloom Connect, `intake` the Mailloom report intake. */
  requires?: 'mail' | 'intake';
};

/** Every place a "New" badge can sit. Add a place here and render `<NewBadge>` there. */
export const BADGE_PLACES = {
  'nav:needs': 'The Needs entry in the desktop sidebar',
} as const;
export type BadgePlace = keyof typeof BADGE_PLACES;

/** An entry is new (Today's card, the nav dot, its "New" badge) this many days, counting its own date. */
export const NEW_DAYS = 14;

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: 'activity-everything',
    date: '2026-11-19',
    title: 'Activity shows everything that changed',
    line: 'Besides tasks, Activity now lists State changes, notes, messages, Needs and projects, with a What filter.',
    where: 'Review › Activity, and the Activity card on a project',
    href: '/review?view=activity',
  },
  {
    id: 'digest-redesign',
    date: '2026-11-18',
    title: 'A shorter morning digest',
    line: 'One message: what needs you (answer from Discord), your top 3 for today, what moved per project and which agents run or stall.',
    where: 'Your Discord DM and the inbox, once a day (Settings › Alerts)',
    href: '/settings?section=alerts',
  },
  {
    id: 'hook-device-key',
    date: '2026-11-18',
    title: 'Session briefs with no extra key',
    line: "Claude Code sessions get the project brief using your PC's Work OS worker, so there is no Claude Code key to paste.",
    where: 'Claude › Setup › Computers (set up the worker on your PC)',
    href: '/claude',
  },
  {
    id: 'mailloom-reports',
    date: '2026-11-18',
    title: 'Mailloom problem reports become tasks',
    line: "A problem someone reports with Mailloom's Report a problem form arrives as a task, tagged mailloom-report.",
    where: "In the Mailloom project's tasks, assigned to its owner",
    href: '/projects',
    requires: 'intake',
  },
  {
    id: 'mail-connect',
    date: '2026-11-16',
    title: 'Connect Mailloom',
    line: 'One click links your Mailloom mailbox, so Claude can read, sort and draft your mail.',
    where: 'Settings › Connections › Mail',
    href: '/settings?section=connections',
    requires: 'mail',
  },
  {
    id: 'needs',
    date: '2026-11-15',
    title: 'Needs',
    line: 'One list of what waits on you: decisions, approvals and asks from teammates and Claude. Answer with a tap.',
    where: 'The Needs tab on the phone, Needs in the sidebar, and on top of Today and Tasks',
    href: '/needs',
    badge: 'nav:needs',
  },
  {
    id: 'results',
    date: '2026-11-15',
    title: 'Results and review',
    line: 'Work a Claude session hands in comes to you to accept, send back, or accept and file what is left.',
    where: 'As a Review Need on Today and on the Needs page',
    href: '/needs',
  },
  {
    id: 'state',
    date: '2026-11-15',
    title: 'Project State',
    line: "Each project's Now, Next and Later, so a new Claude session picks up where the last one stopped.",
    where: 'A project › Overview › State',
    href: '/projects',
  },
  {
    id: 'messages',
    date: '2026-11-15',
    title: 'Project messages',
    line: "Send a project's Claude sessions a decision, request or question, and read what they send back.",
    where: 'A project › Inbox tab',
    href: '/projects',
  },
];

const DAY_MS = 86_400_000;
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
/** Whole days from `date` to `today` (both YYYY-MM-DD); negative when `date` is later. */
export function daysSince(date: string, today: string): number {
  return Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / DAY_MS);
}

/** Live on `today` and still new: from its own date for NEW_DAYS days. */
export const isRecent = (e: WhatsNewEntry, today: string): boolean => {
  const d = daysSince(e.date, today);
  return d >= 0 && d < NEW_DAYS;
};

/** The entries for this Work OS (drops those needing something it has not set up), newest first. */
export function entriesFor(has: { mail: boolean; intake: boolean }): WhatsNewEntry[] {
  return WHATS_NEW.filter(e => !e.requires || has[e.requires]).sort((a, b) => b.date.localeCompare(a.date));
}

/** Unseen entries recent enough for Today and the nav dot, newest first. */
export function recentUnseen(entries: readonly WhatsNewEntry[], seen: ReadonlySet<string>, today: string): WhatsNewEntry[] {
  return entries.filter(e => !seen.has(e.id) && isRecent(e, today));
}

/** Badge places that are "New" today. */
export function activeBadges(entries: readonly WhatsNewEntry[], today: string): BadgePlace[] {
  return entries.filter(e => e.badge && isRecent(e, today)).map(e => e.badge!);
}

/** The entries live on `today`, grouped by date, newest first (the /whats-new page). */
export function byDate(entries: readonly WhatsNewEntry[], today: string): { date: string; entries: WhatsNewEntry[] }[] {
  const out: { date: string; entries: WhatsNewEntry[] }[] = [];
  for (const e of [...entries].filter(e => daysSince(e.date, today) >= 0).sort((a, b) => b.date.localeCompare(a.date))) {
    const last = out[out.length - 1];
    if (last?.date === e.date) last.entries.push(e);
    else out.push({ date: e.date, entries: [e] });
  }
  return out;
}

export const isWhatsNewId = (id: unknown): id is string => typeof id === 'string' && WHATS_NEW.some(e => e.id === id);
export { isDay as isWhatsNewDay };
