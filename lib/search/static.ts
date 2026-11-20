// Settings and Pages for search: static lists, matched in the browser so they answer at once (lib/search/match.ts has
// the rule). Settings come from the Settings sections (app/(app)/settings/sections.ts) plus each setting by name; Pages
// are every page and tab of the app plus four actions.
import { SECTIONS, type SectionId } from '@/app/(app)/settings/sections';
import { matchesAll, tierOf, type Hit, type Query } from './match';

type Entry = { id: string; title: string; meta: string; keywords: string; href: string; action?: Hit['action'] };

/** Each setting by name, in the section that holds it (docs/HANDOVER.md section 9). */
const SETTINGS: [SectionId, string, string][] = [
  ['account', 'Theme', 'dark light appearance mode'],
  ['account', 'Passkeys', 'passkey fingerprint face sign in'],
  ['account', 'Authenticator app', 'two factor 2fa totp backup codes qr'],
  ['account', 'Change password', 'password reset'],
  ['account', 'Test email', 'email mail'],
  ['account', 'Sign out', 'log out logout'],
  ['notifications', 'Install app', 'home screen pwa phone'],
  ['notifications', 'Phone push', 'push notifications alerts phone'],
  ['notifications', 'Push devices', 'phones devices receiving push'],
  ['notifications', 'Alert types', 'due today tomorrow overdue stalled assigned unblocked digest'],
  ['notifications', 'Send test', 'test notification'],
  ['notifications', 'Quiet hours', 'do not disturb night silent'],
  ['notifications', 'Timezone', 'time zone'],
  ['notifications', 'Discord account', 'discord link unlink dm direct message'],
  ['connections', 'Claude connection', 'claude chat connector'],
  ['connections', 'Discord', 'discord'],
  ['connections', 'Computers', 'pc worker machine'],
  ['connections', 'Signed-in apps', 'oauth revoke authorized apps'],
  ['connections', 'Delpat OS link', 'delpat os import'],
  ['connections', 'Calendar link', 'ics subscribe google outlook apple calendar feed'],
  ['ai-tools', 'MCP address', 'mcp server url connect'],
  ['ai-tools', 'Claude Code setup', 'claude code mcp'],
  ['ai-tools', 'Cursor', 'cursor editor'],
  ['ai-tools', 'Antigravity', 'antigravity editor'],
  ['ai-tools', 'ChatGPT', 'chatgpt openai'],
  ['started', 'Get started checklist', 'first steps setup welcome'],
  ['team', 'Members', 'people team'],
  ['team', 'Invite people', 'invitation invite member'],
  ['team', 'Roles', 'owner admin member role'],
  ['team', 'Kinds of work', 'modes mode'],
  ['server', 'Discord server', 'guild sensitive channels blocked register commands'],
  ['server', 'Scheduled checks', 'cron alerts check'],
  ['server', 'Usage', 'requests usage log'],
  ['server', 'Health', 'status health'],
];

const SETTING_ENTRIES: Entry[] = [
  ...SECTIONS.map(s => ({ id: `section:${s.id}`, title: s.label, meta: `Settings · ${s.about}`, keywords: `settings ${s.keywords}`, href: `/settings?section=${s.id}` })),
  ...SETTINGS.map(([sec, title, keywords]) => {
    const s = SECTIONS.find(x => x.id === sec)!;
    return { id: `setting:${sec}:${title}`, title, meta: `Settings › ${s.label}`, keywords: `settings ${keywords}`, href: `/settings?section=${sec}` };
  }),
];

/** Every page and tab, then the actions. */
export const PAGE_ENTRIES: Entry[] = [
  { id: 'today', title: 'Today', meta: 'Page', keywords: 'home day plan overdue due', href: '/today' },
  { id: 'tasks', title: 'Tasks', meta: 'Page', keywords: 'board list todo', href: '/tasks' },
  { id: 'projects', title: 'Projects', meta: 'Page', keywords: 'clients', href: '/projects' },
  { id: 'notes', title: 'Notes', meta: 'Page', keywords: 'pages docs', href: '/notes' },
  { id: 'needs', title: 'Needs', meta: 'Page', keywords: 'decisions approvals questions waiting on you', href: '/needs' },
  { id: 'inbox', title: 'Inbox', meta: 'Page', keywords: 'notifications bell alerts', href: '/notifications' },
  { id: 'claude', title: 'Claude', meta: 'Page', keywords: 'sessions agents ai', href: '/claude' },
  { id: 'claude-now', title: 'Now', meta: 'Claude › Now', keywords: 'claude sessions running', href: '/claude?tab=now' },
  { id: 'claude-workers', title: 'Workers', meta: 'Claude › Workers', keywords: 'claude roster agents', href: '/claude?tab=workers' },
  { id: 'claude-setup', title: 'Set up', meta: 'Claude › Set up', keywords: 'claude setup connect keys computers tools dispatcher', href: '/claude?tab=setup' },
  { id: 'review', title: 'Review', meta: 'Page', keywords: 'look back weekly', href: '/review' },
  { id: 'review-done', title: 'Done', meta: 'Review › Done', keywords: 'review completed finished', href: '/review?view=done' },
  { id: 'review-activity', title: 'Activity', meta: 'Review › Activity', keywords: 'review history changes log', href: '/review?view=activity' },
  { id: 'review-stale', title: 'Stale', meta: 'Review › Stale', keywords: 'review old untouched', href: '/review?view=stale' },
  { id: 'review-archive', title: 'Archive', meta: 'Review › Archive', keywords: 'review archived', href: '/review?view=archive' },
  { id: 'review-trash', title: 'Trash', meta: 'Review › Trash', keywords: 'review deleted restore bin', href: '/review?view=trash' },
  { id: 'schedule', title: 'Schedule', meta: 'Page', keywords: 'timetable calendar week day', href: '/timetable' },
  { id: 'whats-new', title: "What's new", meta: 'Page', keywords: 'whats new features changelog', href: '/whats-new' },
  { id: 'settings', title: 'Settings', meta: 'Page', keywords: 'preferences account', href: '/settings' },
  { id: 'new-task', title: 'New task', meta: 'Action', keywords: 'add create task quick add', href: '/today', action: 'quick-add' },
  { id: 'start-claude', title: 'Start Claude', meta: 'Action', keywords: 'run launch session claude code', href: '/claude', action: 'start-claude' },
  { id: 'new-note', title: 'New note', meta: 'Action', keywords: 'add create note page', href: '/notes?new=1' },
  { id: 'new-project', title: 'New project', meta: 'Action', keywords: 'add create project client', href: '/projects?new=1' },
];

function toHit(kind: 'settings' | 'pages', e: Entry, query: Query | null, i: number): Hit {
  return { kind, id: e.id, title: e.title, meta: e.meta, href: e.href, action: e.action, tier: query ? tierOf(e.title, query) : 4, open: true, mine: false, at: -i };
}

/** Settings or Pages matching the query, best first (all of them, in order, with no words). */
export function matchStatic(kind: 'settings' | 'pages', query: Query | null): Hit[] {
  const list = kind === 'settings' ? SETTING_ENTRIES : PAGE_ENTRIES;
  if (!query) return list.map((e, i) => toHit(kind, e, null, i));
  if (query.refOnly || !query.words.length) return [];
  return list
    .map((e, i) => (matchesAll([e.title, e.meta, e.keywords], query.words) ? toHit(kind, e, query, i) : null))
    .filter((h): h is Hit => !!h)
    .sort((a, b) => a.tier - b.tier || b.at - a.at);
}
