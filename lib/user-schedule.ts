import 'server-only';
import { EMPTY_SCHEDULE, ScheduleSchema, type Schedule } from './schedule';
import { getUserSetting, setUserSetting, type Scope } from './scope';

// Each person's own week (`schedule:<userId>`; lib/schedule.ts has the shape).
// Read on every page (the block bar), so kept a minute per process; a save here clears it.

const TTL_MS = 60_000;
// On globalThis: route handlers, pages and actions can each load their own copy of this module, and a save in one
// must clear what the others read.
const g = globalThis as unknown as { __workosSchedules?: Map<string, { at: number; v: Schedule }> };
const cache = (g.__workosSchedules ??= new Map());
const key = (s: Scope) => `${s.orgId}:${s.userId}`;

function normalise(raw: unknown): Schedule {
  const p = ScheduleSchema.safeParse(raw ?? {});
  if (!p.success) return EMPTY_SCHEDULE;
  return p.data;
}

export async function getSchedule(s: Scope): Promise<Schedule> {
  const hit = cache.get(key(s));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const d = await getUserSetting(s, 'schedule');
  const v = normalise(d?.schedule);
  if (cache.size > 5000) cache.clear();
  cache.set(key(s), { at: Date.now(), v });
  return v;
}

/** Replace parts of the person's schedule (each part is checked; the rest is kept). */
export async function saveSchedule(s: Scope, patch: Partial<Pick<Schedule, 'blocks' | 'colors' | 'taskModes'>>): Promise<Schedule> {
  const d = await getUserSetting(s, 'schedule');
  const cur = ScheduleSchema.safeParse(d?.schedule ?? {});
  const next = ScheduleSchema.parse({ ...(cur.success ? cur.data : {}), ...patch });
  await setUserSetting(s, 'schedule', { schedule: next, updatedAt: new Date() });
  cache.delete(key(s));
  return next;
}
