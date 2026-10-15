import { MODES } from '@/lib/modes';

export type Place = 'today' | 'tasks' | 'projects' | 'notes' | 'claude' | 'inbox' | 'review' | 'schedule' | 'settings' | 'menu';

const under = (path: string, base: string) => path === base || path.startsWith(base + '/');

/** Which place owns this page. Null for pages that belong to none (login, offline). */
export function placeOf(path: string): Place | null {
  if (under(path, '/today')) return 'today';
  if (under(path, '/tasks') || under(path, '/tasks') || under(path, '/modes')) return 'tasks';
  if (under(path, '/projects')) return 'projects';
  if (under(path, '/notes')) return 'notes';
  if (under(path, '/claude')) return 'claude';
  if (under(path, '/notifications')) return 'inbox';
  if (['/review'].some(b => under(path, b))) return 'review';
  if (under(path, '/timetable')) return 'schedule';
  if (['/settings', '/connect', '/recovery'].some(b => under(path, b))) return 'settings';
  if (under(path, '/menu')) return 'menu';
  return null;
}

/** The phone tab a page lights. Notes belong to Projects; Inbox, Review, Schedule, Settings and Menu light nothing. */
export function phoneTabOf(path: string): 'today' | 'projects' | 'claude' | 'tasks' | null {
  const p = placeOf(path);
  if (p === 'today' || p === 'claude' || p === 'tasks' || p === 'projects') return p;
  if (p === 'notes') return 'projects';
  return null;
}

export const modeHref = (name: string) => `/tasks?mode=${encodeURIComponent(name)}`;
export const MODE_LINKS = MODES.map(m => ({ name: m.name, hex: m.hex, href: modeHref(m.name) }));

/** Current URL with ?start=1 added (opens the global Start Claude modal). Client only. */
export function startClaudeUrl(): string {
  const u = new URL(window.location.href);
  u.searchParams.set('start', '1');
  return u.pathname + u.search + u.hash;
}
