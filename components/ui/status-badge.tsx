import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'muted';

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-foreground/80',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  ok: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  muted: 'bg-muted/60 text-muted-foreground',
};

/** The one tone map. Keys are the words the app already shows. */
export const TONES = {
  // Session state (Claude page)
  On: 'ok',
  Working: 'info',
  'Waiting on you': 'warn',
  'Waiting on a person': 'warn',
  Idle: 'muted',
  Off: 'muted',
  Starting: 'info',
  Failed: 'danger',
  'No news': 'warn',
  // Task status
  'Not Started': 'neutral',
  'In Progress': 'info',
  Blocked: 'danger',
  Done: 'ok',
  Dropped: 'muted',
  // Need kind
  decide: 'warn',
  approve: 'warn',
  review: 'info',
  do: 'info',
  chase: 'neutral',
  // Priority
  P1: 'danger',
  P2: 'warn',
  P3: 'neutral',
  P4: 'muted',
} as const satisfies Record<string, Tone>;

export type StatusKey = keyof typeof TONES;

const PRIORITY = new Set(['P1', 'P2', 'P3', 'P4']);

/** A small pill for a state, status, kind or priority. Pass `label` to show other words than the key. */
export function StatusBadge({ status, label, className, ...rest }: { status: StatusKey; label?: React.ReactNode; className?: string } & { [k: `data-${string}`]: string | number | boolean | undefined }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-pill px-2 text-label font-medium whitespace-nowrap shrink-0', TONE[TONES[status]], PRIORITY.has(status) && 'font-mono', className)} {...rest}>
      {label ?? status}
    </span>
  );
}
