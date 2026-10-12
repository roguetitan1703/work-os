// Calendar-date helpers. Due/start dates are stored as 'YYYY-MM-DD' strings in the
// app's timezone (APP_TZ), so "today" means today where the user is, not on the
// (UTC) server.

export const APP_TZ = process.env.APP_TZ || process.env.NEXT_PUBLIC_APP_TZ || 'Asia/Kolkata';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: unknown): s is string {
  return typeof s === 'string' && DATE_RE.test(s);
}

/** 'YYYY-MM-DD' for the given instant in the app timezone. */
export function dateInTz(d: Date = new Date(), tz: string = APP_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function todayStr(): string {
  return dateInTz(new Date());
}

export function addDays(s: string, n: number): string {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(s: string, n: number): string {
  const d = new Date(s + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(s: string): number {
  return new Date(s + 'T00:00:00Z').getUTCDay();
}

/** Monday of the week containing s. */
export function weekStart(s: string): string {
  const wd = weekday(s);
  return addDays(s, wd === 0 ? -6 : 1 - wd);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
}

function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - at.getTime();
}

/** The instant local midnight of `s` begins in the app timezone. */
export function startOfDay(s: string, tz: string = APP_TZ): Date {
  const guess = new Date(s + 'T00:00:00Z');
  const first = new Date(guess.getTime() - tzOffsetMs(guess, tz));
  return new Date(guess.getTime() - tzOffsetMs(first, tz));
}

/** Start of the previous working day (Mon → last Fri). Used as the default "since" for the morning brief. */
export function previousWorkdayStart(today: string = todayStr()): Date {
  let d = addDays(today, -1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, -1);
  return startOfDay(d);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Accepts 'YYYY-MM-DD', 'today', 'tomorrow', 'yesterday', weekday names ('fri',
 * 'friday' → next occurrence, today excluded), '+3d', '+2w', 'next week'.
 * Returns null for empty input, undefined when it can't be parsed.
 */
export function resolveDate(input: string | null | undefined, today: string = todayStr()): string | null | undefined {
  if (input == null) return null;
  const s = input.trim().toLowerCase();
  if (!s || s === 'none' || s === 'null') return null;
  if (DATE_RE.test(s)) return s;
  if (s === 'today' || s === 'tod') return today;
  if (s === 'tomorrow' || s === 'tmr' || s === 'tom') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);
  if (s === 'next week' || s === 'nextweek') return addDays(weekStart(today), 7);
  if (s === 'eow' || s === 'end of week') return addDays(weekStart(today), 4);
  const rel = s.match(/^\+?(\d+)\s*([dwm])$/);
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2] === 'd') return addDays(today, n);
    if (rel[2] === 'w') return addDays(today, n * 7);
    return addMonths(today, n);
  }
  const idx = WEEKDAYS.findIndex(w => s.startsWith(w));
  if (idx !== -1) {
    let delta = (idx - weekday(today) + 7) % 7;
    if (delta === 0) delta = 7;
    return addDays(today, delta);
  }
  return undefined;
}
