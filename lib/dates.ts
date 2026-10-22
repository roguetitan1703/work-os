// Calendar-date helpers. Due/start dates are stored as 'YYYY-MM-DD' strings in the timezone of the person looking
// at them, so "today" means today where they are, not on the (UTC) server.
//
// Each person sets their timezone in Settings (lib/profile.ts). currentTz() is that person's zone for the current
// request: on the server the request context supplies it (lib/request-context.ts registers the source); in the
// browser the app shell sets it once (components/app-context.tsx). Without either: APP_TZ, else UTC.

/** The deployment's default zone, for people who have not set theirs (and system work with no person). */
export const DEFAULT_TZ = (typeof process !== 'undefined' && process.env.APP_TZ) || 'UTC';

let tzSource: (() => string | undefined) | null = null;
let browserTz: string | undefined;

/** Server: where the current request's timezone comes from (set once by lib/request-context.ts). */
export function registerTzSource(fn: () => string | undefined): void {
  tzSource = fn;
}

/** Browser: the signed-in person's timezone (the app shell calls this; one person per tab). */
export function setBrowserTz(tz: string | undefined): void {
  if (typeof window !== 'undefined') browserTz = tz || undefined;
}

/** The timezone of whoever this code runs for. */
export function currentTz(): string {
  return tzSource?.() || browserTz || DEFAULT_TZ;
}

/** Is this an IANA timezone the runtime knows (e.g. "Europe/Berlin")? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: unknown): s is string {
  return typeof s === 'string' && DATE_RE.test(s);
}

/** 'YYYY-MM-DD' for the given instant in the given timezone (default: the current person's). */
export function dateInTz(d: Date = new Date(), tz: string = currentTz()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Today in the current person's timezone (or in tz). */
export function todayStr(tz: string = currentTz()): string {
  return dateInTz(new Date(), tz);
}

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Hour (0–23), minutes since midnight and weekday (0 = Sunday) of an instant in a timezone. */
export function clockInTz(d: Date, tz: string = currentTz()): { hour: number; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return { hour, minutes: hour * 60 + Number(get('minute')), weekday: WD_SHORT.indexOf(get('weekday')) };
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

/** The instant local midnight of `s` begins in the timezone (default: the current person's). */
export function startOfDay(s: string, tz: string = currentTz()): Date {
  const guess = new Date(s + 'T00:00:00Z');
  const first = new Date(guess.getTime() - tzOffsetMs(guess, tz));
  return new Date(guess.getTime() - tzOffsetMs(first, tz));
}

/** Start of the previous working day (Mon → last Fri). Used as the default "since" for the morning brief. */
export function previousWorkdayStart(today: string = todayStr(), tz: string = currentTz()): Date {
  let d = addDays(today, -1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, -1);
  return startOfDay(d, tz);
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
