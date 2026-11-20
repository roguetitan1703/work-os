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
    id: 'worker-updates-itself',
    date: '2026-11-20',
    title: 'The worker on your computer updates itself',
    line: 'After one last run of the install command, the Work OS worker installs new versions by itself, only ones signed with the Work OS release key, and each computer shows its version and when it last updated.',
    where: 'Claude › Setup › Computers',
    href: '/claude?tab=setup',
  },
  {
    id: 'task-place-chips',
    date: '2026-11-20',
    title: 'Task rows show where they sit in the plan',
    line: "A small chip on a task says Now, Next 2 or Later when the project's State names it, so you see what matters before you open it.",
    where: 'Tasks, a project, Today',
    href: '/tasks',
  },
  {
    id: 'sessions-say-why',
    date: '2026-11-20',
    title: 'Sessions now say what they are doing',
    line: 'A project lists each Claude session with the task it is on and the Next line it serves, and Claude › Now shows what each session is doing before its folder and computer.',
    where: 'A project, Working on it now; Claude › Now',
    href: '/claude',
  },
  {
    id: 'task-why',
    date: '2026-11-20',
    title: 'A task now says why it exists',
    line: "Under its title, a task shows why it matters: that it is the project's Now, which Next line it is, the task it is part of, or the first line of its description, with the project's Now below; on the phone the description now comes right after.",
    where: 'The top of any task',
    href: '/tasks',
  },
  {
    id: 'today-projects-now',
    date: '2026-11-20',
    title: 'Today shows the goal of each project',
    line: 'A Projects now card on Today lists the projects with a Claude session, a Need for you or a task of yours, each with its goal and next step; the schedule now shows the block name and its time.',
    where: 'Today, under Needs you',
    href: '/today',
  },
  {
    id: 'project-goal-first',
    date: '2026-11-20',
    title: 'Each project now opens on its goal',
    line: 'A project shows its Now (the goal), who holds it and the next step at the top of every tab, and the Projects list shows the goal on each card instead of a progress bar.',
    where: 'Projects, and the top of any project',
    href: '/projects',
  },
  {
    id: 'lanes',
    date: '2026-11-19',
    title: 'One plan, many sessions',
    line: 'Each Claude session shows its own lane (branch, task, last result); only the session holding Now changes the plan.',
    where: 'Project › Overview, State and Working on it now',
    href: '/projects',
  },
  {
    id: 'claude-moves-on',
    date: '2026-11-19',
    title: 'Claude moves on by itself',
    line: 'A Claude session that stops with work left that waits on nobody is asked to carry on, and the one that holds Now is asked to declutter a long State; each project can turn this off.',
    where: 'A project › Info › Nudges',
    href: '/projects',
  },
  {
    id: 'messages-to-sessions',
    date: '2026-11-19',
    title: 'Messages go to sessions and people',
    line: 'Send a message to one of your sessions or to a teammate; messages for you show under Claude › Now, where you apply, reject or reply. The project Inbox tab is gone.',
    where: 'Claude › Now, Messages for you',
    href: '/claude',
  },
  {
    id: 'sessions-everywhere',
    date: '2026-11-19',
    title: 'Every Claude session is on the roster',
    line: 'Sessions in a folder no project owns now show under No project, with their real name, tool and model, and whether they are running or idle.',
    where: 'Claude › Workers',
    href: '/claude?tab=workers',
  },
  {
    id: 'dispatcher-restart-once',
    date: '2026-11-19',
    title: 'Claude tasks restart once',
    line: "Claude's tasks restart once on their own if the session dies; after that you choose. Never more running at once than you set.",
    where: "Claude › Now, Claude's tasks",
    href: '/claude',
  },
  {
    id: 'notes-shelves',
    date: '2026-11-19',
    title: 'Notes on shelves',
    line: "A project's notes sit on shelves (Overview, Designs, Runbooks, Handovers), and a second note with the same title is refused.",
    where: "A project's Notes tab, and the shelf filter on Notes",
    href: '/notes',
  },
  {
    id: 'quiet-phone-monday-numbers',
    date: '2026-11-19',
    title: 'Quieter phone, Monday numbers',
    line: 'Your phone now buzzes only when an agent session is waiting on your answer, a person asks you, or a release needs your yes; the rest waits for the digest, which on Mondays adds four numbers and up to three proposals.',
    where: 'Settings › Alerts',
    href: '/settings',
  },
  {
    id: 'declutter-project',
    date: '2026-11-19',
    title: 'Declutter a project',
    line: 'Work OS proposes a tidy-up when a project grows; you tick what goes, and nothing is deleted.',
    where: 'Project › ⋯ › Declutter, and Needs',
    href: '/needs',
  },
  {
    id: 'orders-versions',
    date: '2026-11-19',
    title: 'Your Claude can now fix your Orders',
    line: "Every change keeps a version you can undo on the page; teammates' Claude proposes changes as a Need.",
    where: 'Any Orders page, under Changes',
    href: '/notes',
  },
  {
    id: 'folder-decides-project',
    date: '2026-11-19',
    title: 'A new folder asks which project it is for',
    line: 'A Claude session in a new folder asks which project it is for and files it; folders you say are not Work OS stay quiet (Claude › Setup › Computers).',
    where: 'Claude › Setup › Computers, Not Work OS folders, and the Sessions list on Claude › Now',
    href: '/claude?tab=setup',
  },
  {
    id: 'agents-feedback',
    date: '2026-11-19',
    title: 'Agents tell you what got in their way',
    line: 'An agent that hits a refused call or a blocking rule now says so in one line, which shows in the project’s activity next to the line it leaves when it stops.',
    where: 'Review › Activity, What: State',
    href: '/review?view=activity',
  },
  {
    id: 'agents-ask-before-production',
    date: '2026-11-19',
    title: 'Agents ask before production',
    line: 'A push or release to production now waits for your yes on a release Need; Yes for 24 hours covers the day.',
    where: 'Needs, and the project page under Code › Production',
    href: '/needs',
  },
  {
    id: 'messages-reach-sessions',
    date: '2026-11-19',
    title: 'Messages reach Claude Code sessions',
    line: 'A message to a working Claude Code session reaches it after its next step; an idle one wakes for a direct request or question.',
    where: "The project's Inbox tab",
    href: '/projects',
  },
  {
    id: 'claude-session-state',
    date: '2026-11-19',
    title: 'Each Claude session shows its real state',
    line: 'The Claude page shows each Claude Code session as working, waiting on you, idle or off, straight from Claude Code.',
    where: 'Claude › Now and Workers',
    href: '/claude',
  },
  {
    id: 'end-work-handover',
    date: '2026-11-19',
    title: 'Sessions hand over through Work OS',
    line: 'A session that stops leaves a handover note on the project, and your next session, in Claude Code or Claude chat, picks it up.',
    where: "The project's notes",
    href: '/projects',
  },
  {
    id: 'pc-setup-one-go',
    date: '2026-11-19',
    title: 'Set up a new PC in one go',
    line: 'Link matching folders on a computer, and each computer shows whether its Work OS hooks are on.',
    where: 'Claude › Setup › Computers',
    href: '/claude',
  },
  {
    id: 'needs-typed-answer',
    date: '2026-11-19',
    title: 'Answer a Need in your own words',
    line: 'Type your answer under a Need and press Send my answer (or Ctrl+Enter); no option button needed.',
    where: 'Needs you on Today, and Needs',
    href: '/needs',
  },
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
