import 'server-only';
import type { ClaudeUsageDoc, SessionOrigin } from '../db';
import { addDays, clockInTz, dateInTz, isTimeZone } from '../dates';
import { getUserSetting, scoped, setUserSetting, type Scope } from '../scope';
import { quietly } from '../live';
import { InputError } from './errors';

// Claude usage per session (Work OS note a289ffec58). Workers send each day's token counts per session, part (main
// conversation or one subagent) and model, read from Claude Code's own transcripts: counts only, never message text.
// The page and the `usage` tool show an ESTIMATED share of the person's own use: weight = tokens × the price ratio of
// the model × the price ratio of the kind of token. It is not a share of any limit: Anthropic does not publish the limit.

// Price ratios (Sonnet = 1): Opus and Fable cost 5/3 of Sonnet, Haiku 1/3; a cache write costs 1.25 input tokens, a
// cache read 0.1, an output token 5.
export const MODEL_WEIGHT = { opus: 5 / 3, fable: 5 / 3, sonnet: 1, haiku: 1 / 3 } as const;
export const KIND_WEIGHT = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

export type ModelFamily = 'Opus' | 'Fable' | 'Sonnet' | 'Haiku' | 'Other';
export function familyOf(model: string): ModelFamily {
  const m = model.toLowerCase();
  return m.includes('opus') ? 'Opus' : m.includes('fable') ? 'Fable' : m.includes('sonnet') ? 'Sonnet' : m.includes('haiku') ? 'Haiku' : 'Other';
}
/** 'claude-opus-4-5-20251101' → 'Opus 4.5'; anything else as it came. */
export function modelName(model: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/i.exec(model);
  if (!m) return model.slice(0, 40);
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}
export const modelFactor = (model: string): number => {
  const f = familyOf(model);
  return f === 'Other' ? 1 : MODEL_WEIGHT[f.toLowerCase() as keyof typeof MODEL_WEIGHT];
};
type Counts = { i: number; cw: number; cr: number; o: number };
export const weightOf = (model: string, c: Counts): number => modelFactor(model) * (c.i * KIND_WEIGHT.input + c.cw * KIND_WEIGHT.cacheWrite + c.cr * KIND_WEIGHT.cacheRead + c.o * KIND_WEIGHT.output);
const tokensOf = (c: Counts) => c.i + c.cw + c.cr + c.o;

// ── Plan reset ──
export type PlanReset = { weekday: number; time: string; tz: string };
export const DEFAULT_RESET: PlanReset = { weekday: 2, time: '16:30', tz: 'Asia/Kolkata' }; // Tuesday 16:30 IST
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function getPlanReset(s: Scope): Promise<PlanReset> {
  const r = (await getUserSetting(s, 'profile'))?.claudePlanReset;
  return r && Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 && TIME.test(r.time) && isTimeZone(r.tz) ? r : DEFAULT_RESET;
}

export async function savePlanReset(s: Scope, input: { weekday: number; time: string; tz: string }): Promise<PlanReset> {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw new InputError('Pick a weekday');
  if (!TIME.test(input.time)) throw new InputError('The time is hours and minutes, like 16:30');
  if (!isTimeZone(input.tz)) throw new InputError('Pick a timezone from the list');
  const r = { weekday: input.weekday, time: input.time, tz: input.tz };
  await setUserSetting(s, 'profile', { claudePlanReset: r });
  return r;
}

export type UsageRangeKey = 'week' | '7d' | 'today';
export const RANGE_KEYS: UsageRangeKey[] = ['week', '7d', 'today'];

/** The first day (YYYY-MM-DD, the person's zone) a range takes in. A day counts whole, so the day of the reset counts from its start. */
export function rangeFrom(key: UsageRangeKey, reset: PlanReset, tz: string, now: Date): { from: string; label: string } {
  const today = dateInTz(now, tz);
  if (key === 'today') return { from: today, label: 'Today' };
  if (key === '7d') return { from: addDays(today, -6), label: 'Last 7 days' };
  const c = clockInTz(now, reset.tz);
  const [h, m] = reset.time.split(':').map(Number);
  const back = (c.weekday - reset.weekday + 7) % 7;
  let day = addDays(dateInTz(now, reset.tz), -back);
  if (back === 0 && c.minutes < h * 60 + m) day = addDays(day, -7);
  return { from: day, label: `This week, since ${WEEKDAYS[reset.weekday].slice(0, 3)} ${reset.time}` };
}

// ── Worker side: saving a report ──
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART = /^(main|agent-[A-Za-z0-9_-]{1,60})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ORIGINS: SessionOrigin[] = ['vscode', 'cli', 'desktop', 'other'];
const MAX_ROWS = 300;
const MAX_SESSIONS = 100;
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e12) : 0);
const line = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : '');

type CleanRow = { sessionId: string; part: string; partName: string; model: string; day: string; i: number; cw: number; cr: number; o: number };
export function cleanUsage(raw: unknown): { rows: CleanRow[]; sessions: Map<string, { title: string; folder: string; origin: SessionOrigin }> } {
  const b = (raw ?? {}) as { rows?: unknown; sessions?: unknown };
  if (!Array.isArray(b.rows) || (b.sessions !== undefined && !Array.isArray(b.sessions))) throw new InputError('usage must have rows and sessions as arrays');
  const sessions = new Map<string, { title: string; folder: string; origin: SessionOrigin }>();
  for (const x of ((b.sessions as unknown[]) ?? []).slice(0, MAX_SESSIONS)) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || !SID.test(o.sessionId)) continue;
    sessions.set(o.sessionId, { title: line(o.title, 80), folder: line(o.folder, 80) || 'unknown', origin: ORIGINS.includes(o.origin as SessionOrigin) ? (o.origin as SessionOrigin) : 'other' });
  }
  const rows: CleanRow[] = [];
  const earliest = Date.now() - 35 * 86_400_000; // the worker sends at most 30 days back
  for (const x of b.rows.slice(0, MAX_ROWS)) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || !SID.test(o.sessionId) || typeof o.part !== 'string' || !PART.test(o.part)) continue;
    if (typeof o.day !== 'string' || !DAY.test(o.day) || Number.isNaN(Date.parse(o.day + 'T00:00:00Z')) || Date.parse(o.day + 'T00:00:00Z') < earliest || Date.parse(o.day + 'T00:00:00Z') > Date.now() + 2 * 86_400_000) continue;
    const model = line(o.model, 80);
    if (!model || model === '<synthetic>') continue;
    rows.push({ sessionId: o.sessionId, part: o.part, partName: o.part === 'main' ? '' : line(o.partName, 80) || o.part, model, day: o.day, i: count(o.i), cw: count(o.cw), cr: count(o.cr), o: count(o.o) });
  }
  return { rows, sessions };
}

/** Takes a worker's usage rows: a day's total replaces the one stored (the worker sends whole days). Quiet: no page refresh. */
export async function saveUsage(s: Scope, deviceId: string, raw: unknown): Promise<void> {
  const { rows, sessions } = cleanUsage(raw);
  if (!rows.length) return;
  const c = await scoped(s);
  const now = new Date();
  await quietly(async () => {
    await c.claudeUsage.bulkWrite(
      rows.map(r => {
        const meta = sessions.get(r.sessionId) ?? { title: '', folder: 'unknown', origin: 'other' as SessionOrigin };
        return {
          updateOne: {
            filter: { _id: `${deviceId}:${r.sessionId}:${r.part}:${r.model}:${r.day}` },
            update: { $set: { deviceId, sessionId: r.sessionId, part: r.part, ...(r.partName ? { partName: r.partName } : {}), model: r.model, day: r.day, dayAt: new Date(r.day + 'T00:00:00Z'), i: r.i, cw: r.cw, cr: r.cr, o: r.o, title: meta.title, folder: meta.folder, origin: meta.origin, updatedAt: now } },
            upsert: true,
          },
        };
      }) as never,
      { ordered: false },
    );
  });
}

// ── Reading: the page and the `usage` tool ──
export type UsageSlice = { key: string; name: string; weight: number; share: number };
export type UsageSession = {
  sessionId: string;
  title: string;
  folder: string;
  origin: SessionOrigin;
  computer: string;
  project: { id: string; name: string } | null;
  weight: number;
  share: number;
  tokens: number;
  models: UsageSlice[];
  subagents: { count: number; weight: number; share: number; items: { id: string; name: string; weight: number; share: number; models: UsageSlice[] }[] };
  lastDay: string;
};
export type UsageReport = {
  range: UsageRangeKey;
  label: string;
  from: string;
  to: string;
  reset: PlanReset;
  total: number;
  tokens: number;
  byProject: UsageSlice[];
  bySession: UsageSession[];
  byModel: UsageSlice[];
  byDay: { day: string; weight: number; share: number }[];
  hasAny: boolean;
  updatedAt: string | null;
};

const MAX_SESSIONS_OUT = 40;
const slices = (m: Map<string, { name: string; weight: number }>, total: number, max = 12): UsageSlice[] =>
  [...m.entries()]
    .map(([key, v]) => ({ key, name: v.name, weight: Math.round(v.weight), share: total ? v.weight / total : 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max);
function bump(m: Map<string, { name: string; weight: number }>, key: string, name: string, w: number) {
  const x = m.get(key);
  if (x) x.weight += w;
  else m.set(key, { name, weight: w });
}

export async function usageReport(s: Scope, opts: { range?: string; tz: string; now?: Date }): Promise<UsageReport> {
  const range: UsageRangeKey = RANGE_KEYS.includes(opts.range as UsageRangeKey) ? (opts.range as UsageRangeKey) : 'week';
  const now = opts.now ?? new Date();
  const reset = await getPlanReset(s);
  const { from, label } = rangeFrom(range, reset, opts.tz, now);
  const to = dateInTz(now, opts.tz);
  const c = await scoped(s);
  const found = (await c.claudeUsage.find({ day: { $gte: from } }).limit(20000).toArray()) as ClaudeUsageDoc[];
  const any = (await c.claudeUsage.findOne({}, { projection: { _id: 1 } })) !== null;

  // Computer names, and which project owns each folder (the folder's name on that computer).
  const deviceIds = [...new Set(found.map(d => d.deviceId))];
  const devices = deviceIds.length ? await c.devices.find({ _id: { $in: deviceIds } }, { projection: { name: 1, revokedAt: 1 } }).toArray() : [];
  const deviceName = new Map(devices.map(d => [d._id, d.name]));
  // A report in flight when its computer was revoked can land after revokeDevice deleted the rows: a revoked computer's rows never count.
  const revoked = new Set(devices.filter(d => d.revokedAt).map(d => d._id));
  const docs = revoked.size ? found.filter(d => !revoked.has(d.deviceId)) : found;
  const folders = deviceIds.length ? await c.workerFolders.find({ deviceId: { $in: deviceIds }, projectId: { $ne: null } }, { projection: { deviceId: 1, name: 1, projectId: 1 } }).toArray() : [];
  const projectOfFolder = new Map(folders.map(f => [`${f.deviceId}|${f.name}`, f.projectId as string]));
  const projIds = [...new Set(projectOfFolder.values())];
  const projects = projIds.length ? await c.projects.find({ _id: { $in: projIds } }, { projection: { name: 1 } }).toArray() : [];
  const projectName = new Map(projects.map(p => [p._id, p.name]));

  type Acc = { meta: ClaudeUsageDoc; total: number; tokens: number; models: Map<string, { name: string; weight: number }>; parts: Map<string, { name: string; weight: number; models: Map<string, { name: string; weight: number }> }>; lastDay: string };
  const sessions = new Map<string, Acc>();
  const byModel = new Map<string, { name: string; weight: number }>();
  const byDay = new Map<string, number>();
  let total = 0;
  let tokens = 0;
  let updated = 0;
  for (const d of docs) {
    const w = weightOf(d.model, d);
    total += w;
    tokens += tokensOf(d);
    updated = Math.max(updated, d.updatedAt?.getTime() ?? 0);
    bump(byModel, familyOf(d.model) === 'Other' ? d.model : modelName(d.model), familyOf(d.model) === 'Other' ? d.model : modelName(d.model), w);
    byDay.set(d.day, (byDay.get(d.day) ?? 0) + w);
    const key = `${d.deviceId}|${d.sessionId}`;
    let a = sessions.get(key);
    if (!a) sessions.set(key, (a = { meta: d, total: 0, tokens: 0, models: new Map(), parts: new Map(), lastDay: d.day }));
    if (d.day >= a.lastDay) { a.lastDay = d.day; if (d.title || !a.meta.title) a.meta = d; }
    a.total += w;
    a.tokens += tokensOf(d);
    const mn = modelName(d.model);
    bump(a.models, mn, mn, w);
    let p = a.parts.get(d.part);
    if (!p) a.parts.set(d.part, (p = { name: d.partName || d.part, weight: 0, models: new Map() }));
    if (d.partName) p.name = d.partName;
    p.weight += w;
    bump(p.models, mn, mn, w);
  }

  const bySession: UsageSession[] = [];
  const byProject = new Map<string, { name: string; weight: number }>();
  for (const [key, a] of sessions) {
    const deviceId = key.split('|')[0];
    const pid = projectOfFolder.get(`${deviceId}|${a.meta.folder}`);
    const pname = pid ? projectName.get(pid) : undefined;
    bump(byProject, pid && pname ? pid : 'none', pid && pname ? pname : 'No project', a.total);
    const subs = [...a.parts.entries()].filter(([part]) => part !== 'main');
    const subWeight = subs.reduce((n, [, p]) => n + p.weight, 0);
    bySession.push({
      sessionId: a.meta.sessionId,
      title: a.meta.title || a.meta.folder,
      folder: a.meta.folder,
      origin: a.meta.origin,
      computer: deviceName.get(deviceId) ?? 'a computer',
      project: pid && pname ? { id: pid, name: pname } : null,
      weight: Math.round(a.total),
      share: total ? a.total / total : 0,
      tokens: a.tokens,
      models: slices(a.models, a.total, 4),
      subagents: {
        count: subs.length,
        weight: Math.round(subWeight),
        share: a.total ? subWeight / a.total : 0,
        items: subs
          .sort((x, y) => y[1].weight - x[1].weight)
          .slice(0, 20)
          .map(([id, p]) => ({ id, name: p.name, weight: Math.round(p.weight), share: total ? p.weight / total : 0, models: slices(p.models, p.weight, 3) })),
      },
      lastDay: a.lastDay,
    });
  }
  bySession.sort((x, y) => y.weight - x.weight);
  const days: { day: string; weight: number; share: number }[] = [];
  for (let d = from; d <= to && days.length < 100; d = addDays(d, 1)) days.push({ day: d, weight: Math.round(byDay.get(d) ?? 0), share: total ? (byDay.get(d) ?? 0) / total : 0 });
  return {
    range,
    label,
    from,
    to,
    reset,
    total: Math.round(total),
    tokens,
    byProject: slices(byProject, total, 20),
    bySession: bySession.slice(0, MAX_SESSIONS_OUT),
    byModel: slices(byModel, total, 12),
    byDay: days,
    hasAny: any,
    updatedAt: updated ? new Date(updated).toISOString() : null,
  };
}
