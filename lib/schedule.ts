import { z } from 'zod';
import { clockInTz } from './dates';
import { isHex } from './modes';

// A person's week (docs/multi-user.md phase 3): time blocks Monday to Friday (Saturday and Sunday are flex days), the
// optional daily routine card on Today, their weekly review questions and their own help text. Stored per person in
// `schedule:<userId>` (lib/user-schedule.ts); someone who never set one has none: no block bar, no routine card.
// Pure (browser and server).

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
export type Wd = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Wd, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };
const WD_BY_DAY = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;

/** 0 = Sunday … 6 = Saturday → 'mon'…'fri', or null at the weekend. */
export const weekdayKey = (day: number): Wd | null => WD_BY_DAY[day] ?? null;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(TIME_RE, 'a time like 09:30');
const label = (max: number) => z.string().trim().max(max);

export const ScheduleBlockSchema = z.object({
  start: time,
  end: time,
  block: label(80).min(1),
  duration: label(30).optional(),
  /** Per weekday: an organization mode (its tasks show in the block) or one of the person's own names (`colors`). */
  modes: z.object(Object.fromEntries(WEEKDAYS.map(d => [d, label(40).default('')])) as Record<Wd, z.ZodDefault<z.ZodString>>),
  notes: label(500).default(''),
});
export type ScheduleBlock = z.infer<typeof ScheduleBlockSchema>;

export const RoutineSchema = z.object({
  name: label(40).min(1),
  start: time,
  end: time,
  color: z.string().refine(isHex, 'a colour like #FACC15'),
  /** The number logged each day, e.g. "Bids placed". */
  countLabel: label(40).min(1),
  /** The prompt before it is logged today. */
  question: label(120).min(1),
  placeholder: label(120).optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const ReviewFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/),
  label: label(60).min(1),
  kind: z.enum(['text', 'number']),
});
export type ReviewField = z.infer<typeof ReviewFieldSchema>;

export const HelpSectionSchema = z.object({
  title: label(80).min(1),
  hint: label(120).optional(),
  items: z.array(z.object({ title: label(80).optional(), text: label(1000).min(1) })).max(20),
});
export type HelpSection = z.infer<typeof HelpSectionSchema>;

export const ScheduleSchema = z.object({
  blocks: z.array(ScheduleBlockSchema).max(48).default([]),
  /** Colours for block names that are not organization modes (a routine, a break, meetings). */
  colors: z.record(label(40), z.string().refine(isHex)).default({}),
  /** Block names whose time belongs to an organization mode's tasks ('' = none), e.g. "Setup/Close" → "Business Admin". */
  taskModes: z.record(label(40), label(40)).default({}),
  routine: RoutineSchema.nullable().default(null),
  review: z.array(ReviewFieldSchema).min(1).max(12).optional(),
  help: z.array(HelpSectionSchema).max(10).default([]),
});
export type Schedule = Omit<z.infer<typeof ScheduleSchema>, 'review'> & { review: ReviewField[] };

/** Weekly review questions for someone who has not set their own. */
export const DEFAULT_REVIEW: ReviewField[] = [
  { key: 'shipped', label: 'Shipped', kind: 'text' },
  { key: 'slipped', label: 'Slipped', kind: 'text' },
  { key: 'toDrop', label: 'To drop', kind: 'text' },
  { key: 'adjustments', label: 'Adjustments for next week', kind: 'text' },
];

export const EMPTY_SCHEDULE: Schedule = { blocks: [], colors: {}, taskModes: {}, routine: null, review: DEFAULT_REVIEW, help: [] };

/** What the app shell needs on every page (the block bar and tint): no review or help text. */
export type WeekPlan = Pick<Schedule, 'blocks' | 'colors' | 'taskModes'>;

const minutesOf = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export function blockMinutes(b: Pick<ScheduleBlock, 'start' | 'end'>): number {
  const start = minutesOf(b.start);
  let end = minutesOf(b.end);
  if (end <= start) end += 24 * 60;
  return end - start;
}

/** "90 min", "2 hr", "1 hr 30 min" from a block's times (for blocks saved without a duration label). */
export function durationLabel(b: Pick<ScheduleBlock, 'start' | 'end' | 'duration'>): string {
  if (b.duration) return b.duration;
  const m = blockMinutes(b);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`;
}

/**
 * The block running at `now` in the person's timezone, or null. Weekends have no blocks unless allowWeekend (Today's
 * "work day" switch), which uses Monday's.
 */
export function currentBlock(blocks: readonly ScheduleBlock[], now: Date, tz: string, allowWeekend = false): { block: ScheduleBlock; weekday: Wd } | null {
  const clock = clockInTz(now, tz);
  const weekday = weekdayKey(clock.weekday) ?? (allowWeekend ? 'mon' : null);
  if (!weekday) return null;
  for (const blk of blocks) {
    const startMin = minutesOf(blk.start);
    const endMin = startMin + blockMinutes(blk);
    // A late block that runs past midnight (23:30–00:30) still holds just after midnight.
    const nowMin = startMin > 23 * 60 && clock.minutes < 6 * 60 ? clock.minutes + 24 * 60 : clock.minutes;
    if (nowMin >= startMin && nowMin < endMin) return { block: blk, weekday };
  }
  return null;
}

/** The organization mode whose tasks belong in a block of this name (null: none). */
export function taskModeFor(plan: Pick<WeekPlan, 'taskModes'>, blockMode: string | null | undefined): string | null {
  if (!blockMode) return null;
  return blockMode in plan.taskModes ? plan.taskModes[blockMode] || null : blockMode;
}
