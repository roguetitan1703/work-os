import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'info' | 'sky' | 'ok' | 'warn' | 'danger' | 'muted';

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-foreground/80',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  ok: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  muted: 'bg-muted/60 text-muted-foreground',
};

/** The one tone map. Keys are the words the app already shows. */
export const TONES = {
  // Session state (the Sessions list: Today, the Claude page, a project page). Live states are coloured, dead ones grey.
  Working: 'ok',
  'Waiting on you': 'warn',
  'Waiting on a person': 'warn',
  Idle: 'sky',
  Quiet: 'muted',
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

/**
 * Session states carry a dot: live ones are filled (working and starting pulse softly, waiting glows), dead or unknown ones
 * are a hollow ring. One look tells a live session from a gone one, whatever the colour.
 */
type Dot = 'pulse' | 'glow' | 'solid' | 'hollow';
const DOT: Partial<Record<StatusKey, Dot>> = {
  Working: 'pulse',
  Starting: 'pulse',
  'Waiting on you': 'glow',
  'Waiting on a person': 'glow',
  Idle: 'solid',
  Quiet: 'hollow',
  Off: 'hollow',
  Failed: 'hollow',
  'No news': 'hollow',
};
const DOT_FILL: Record<Tone, string> = {
  neutral: 'bg-foreground/60',
  info: 'bg-blue-500',
  sky: 'bg-sky-500',
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
  muted: 'bg-muted-foreground',
};
const DOT_RING: Record<Tone, string> = {
  neutral: 'border-foreground/60',
  info: 'border-blue-500',
  sky: 'border-sky-500',
  ok: 'border-green-500',
  warn: 'border-amber-500',
  danger: 'border-red-500',
  muted: 'border-muted-foreground/70',
};

function StateDot({ status }: { status: StatusKey }) {
  const dot = DOT[status];
  if (!dot) return null;
  const tone = TONES[status];
  return (
    <span
      aria-hidden
      data-state-dot={dot}
      className={cn(
        'mr-1.5 inline-block size-1.5 shrink-0 rounded-full align-middle',
        dot === 'hollow' ? cn('border', DOT_RING[tone]) : DOT_FILL[tone],
        dot === 'pulse' && 'animate-pulse motion-reduce:animate-none',
        dot === 'glow' && 'ring-2 ring-amber-500/30',
      )}
    />
  );
}

const PRIORITY = new Set(['P1', 'P2', 'P3', 'P4']);

/** A small pill for a state, status, kind or priority. Pass `label` to show other words than the key. */
export function StatusBadge({ status, label, className, ...rest }: { status: StatusKey; label?: React.ReactNode; className?: string } & { [k: `data-${string}`]: string | number | boolean | undefined }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-pill px-2 text-label font-medium whitespace-nowrap shrink-0', TONE[TONES[status]], PRIORITY.has(status) && 'font-mono', className)} {...rest}>
      <StateDot status={status} />
      {label ?? status}
    </span>
  );
}
