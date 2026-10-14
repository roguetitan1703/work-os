import { format, parseISO, formatDistanceToNowStrict } from 'date-fns';
import type { Priority, Status } from './types';

export function fmtMins(m: number | null | undefined): string {
  if (!m) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export function fmtDate(d?: string | null, pattern = 'MMM d'): string {
  if (!d) return '';
  try {
    return format(parseISO(d), pattern);
  } catch {
    return d;
  }
}

/** "Today", "Tomorrow", "Yesterday", "3d overdue" … relative to `today` (YYYY-MM-DD). */
export function fmtDue(due: string | null | undefined, today: string): string {
  if (!due) return '';
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return fmtDate(due, 'EEE');
  return fmtDate(due, 'MMM d');
}

export function fmtAgo(iso: string): string {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function fmtDateTime(iso: string): string {
  try {
    return format(parseISO(iso), 'MMM d, HH:mm');
  } catch {
    return iso;
  }
}

export const STATUS_TEXT: Record<Status, string> = {
  'Not Started': 'text-muted-foreground',
  'In Progress': 'text-blue-600 dark:text-blue-400',
  Blocked: 'text-red-600 dark:text-red-400',
  Done: 'text-green-600 dark:text-green-400',
  Dropped: 'text-muted-foreground line-through',
};

export const STATUS_DOT: Record<Status, string> = {
  'Not Started': 'bg-muted-foreground/40',
  'In Progress': 'bg-blue-500',
  Blocked: 'bg-red-500',
  Done: 'bg-green-500',
  Dropped: 'bg-muted-foreground/20',
};

export const PRIORITY_TEXT: Record<Priority, string> = {
  P1: 'text-red-600 dark:text-red-400',
  P2: 'text-orange-600 dark:text-orange-400',
  P3: 'text-yellow-600 dark:text-yellow-400',
  P4: 'text-muted-foreground',
};

export const ACTOR_STYLE: Record<string, string> = {
  me: 'bg-muted text-foreground',
  claude: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'claude-code': 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  system: 'bg-muted text-muted-foreground',
  discord: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
};
