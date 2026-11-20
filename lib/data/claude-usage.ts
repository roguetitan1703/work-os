import 'server-only';
import type { ClaudeUsageDoc, ClaudeUsageEventDoc, SessionOrigin } from '../db';
import { addDays, clockInTz, dateInTz, isTimeZone } from '../dates';
import { getUserSetting, scoped, setUserSetting, type Scope } from '../scope';
import { quietly } from '../live';
import { InputError } from './errors';

// Claude usage per session (Work OS note a289ffec58). Workers send each day's token counts per session, part (main
// conversation or one subagent) and model, read from Claude Code's own transcripts: counts only, never message text.
// The page and the `usage` tool show an ESTIMATED share of the person's own use: weight = tokens × the price ratio of
// the model × the price ratio of the kind of token. It is not a share of any limit: Anthropic does not publish the limit.
// Besides the day rows a worker also sends 5-minute buckets (last 7 days), limit hits and compactions (each once) and the
// label of its Claude account (a hash id and the part of the email before @); all owner only (note e6036c777f).

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

const ACCT = /^[0-9a-f]{16}$/;
const EVENT_ID = /^[0-9a-f-]{36}$/i;
const MAX_BUCKETS = 1000;
const MAX_EVENTS = 200;
const MAX_ACCOUNTS = 10;
const BUCKET_MS = 5 * 60_000;
const acctOf = (v: unknown) => (typeof v === 'string' && ACCT.test(v) ? v : '');
const dateOf = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
};

type CleanRow = { sessionId: string; part: string; partName: string; model: string; day: string; i: number; cw: number; cr: number; o: number; acct: string };
type CleanBucket = { sessionId: string; part: string; model: string; at: Date; acct: string; i: number; cw: number; cw1h: number; cr: number; o: number; n: number; peakCtx: number };
type CleanEvent = { id: string; sessionId: string; part: string; kind: 'limit' | 'compact'; at: Date; acct: string; which?: '5h' | 'weekly' | 'other'; resetAt?: Date | null; trigger?: string; pre?: number; post?: number };
type Cleaned = {
  rows: CleanRow[];
  sessions: Map<string, { title: string; folder: string; origin: SessionOrigin }>;
  buckets: CleanBucket[];
  events: CleanEvent[];
  accounts: { id: string; label: string }[];
};
export function cleanUsage(raw: unknown): Cleaned {
  const b = (raw ?? {}) as { rows?: unknown; sessions?: unknown; buckets?: unknown; events?: unknown; accounts?: unknown };
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
    rows.push({ sessionId: o.sessionId, part: o.part, partName: o.part === 'main' ? '' : line(o.partName, 80) || o.part, model, day: o.day, i: count(o.i), cw: count(o.cw), cr: count(o.cr), o: count(o.o), acct: acctOf(o.acct) });
  }

  // 5-minute buckets: a worker from before them sends none.
  const buckets: CleanBucket[] = [];
  const bEarliest = Date.now() - 8 * 86_400_000;
  for (const x of Array.isArray(b.buckets) ? b.buckets.slice(0, MAX_BUCKETS) : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || !SID.test(o.sessionId) || typeof o.part !== 'string' || !PART.test(o.part)) continue;
    const at = dateOf(o.at);
    if (!at || at.getTime() % BUCKET_MS !== 0 || at.getTime() < bEarliest || at.getTime() > Date.now() + 2 * 86_400_000) continue;
    const model = line(o.model, 80);
    if (!model || model === '<synthetic>') continue;
    buckets.push({ sessionId: o.sessionId, part: o.part, model, at, acct: acctOf(o.acct), i: count(o.i), cw: count(o.cw), cw1h: count(o.cw1h), cr: count(o.cr), o: count(o.o), n: count(o.n), peakCtx: count(o.peakCtx) });
  }

  // Limit hits and compactions.
  const events: CleanEvent[] = [];
  const eEarliest = Date.now() - 35 * 86_400_000;
  for (const x of Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (o.kind !== 'limit' && o.kind !== 'compact') continue;
    if (typeof o.id !== 'string' || !EVENT_ID.test(o.id)) continue;
    if (typeof o.sessionId !== 'string' || !SID.test(o.sessionId) || typeof o.part !== 'string' || !PART.test(o.part)) continue;
    const at = dateOf(o.at);
    if (!at || at.getTime() < eEarliest || at.getTime() > Date.now() + 2 * 86_400_000) continue;
    const e: CleanEvent = { id: o.id, sessionId: o.sessionId, part: o.part, kind: o.kind, at, acct: acctOf(o.acct) };
    if (o.kind === 'limit') {
      e.which = o.which === '5h' || o.which === 'weekly' ? o.which : 'other';
      e.resetAt = dateOf(o.resetAt);
    } else {
      e.trigger = o.trigger === 'auto' || o.trigger === 'manual' ? o.trigger : 'other';
      e.pre = count(o.pre);
      e.post = count(o.post);
    }
    events.push(e);
  }

  const accounts: { id: string; label: string }[] = [];
  for (const x of Array.isArray(b.accounts) ? b.accounts.slice(0, MAX_ACCOUNTS) : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ACCT.test(o.id)) continue;
    accounts.push({ id: o.id, label: line(o.label, 40) });
  }
  return { rows, sessions, buckets, events, accounts };
}

/** The organization's Orders version now (0 when it has no Orders): stamped on what a report writes, so a later reading can tell which Orders were in force. */
async function ordersVersion(c: Awaited<ReturnType<typeof scoped>>): Promise<number> {
  const n = await c.notes.findOne({ orders: 'org', visibility: 'org', deletedAt: null, archived: false }, { sort: { createdAt: 1 }, projection: { ordersV: 1 } });
  return n ? (n.ordersV ?? 1) : 0;
}

/** Takes a worker's usage rows: a day's total replaces the one stored (the worker sends whole days). Quiet: no page refresh. */
export async function saveUsage(s: Scope, deviceId: string, raw: unknown): Promise<void> {
  const { rows, sessions, buckets, events, accounts } = cleanUsage(raw);
  if (!rows.length && !buckets.length && !events.length && !accounts.length) return;
  const c = await scoped(s);
  const now = new Date();
  const ov = await ordersVersion(c);
  await quietly(async () => {
    if (rows.length) await c.claudeUsage.bulkWrite(
      rows.map(r => {
        const meta = sessions.get(r.sessionId) ?? { title: '', folder: 'unknown', origin: 'other' as SessionOrigin };
        return {
          updateOne: {
            filter: { _id: `${deviceId}:${r.sessionId}:${r.part}:${r.model}:${r.day}` },
            update: { $set: { deviceId, sessionId: r.sessionId, part: r.part, ...(r.partName ? { partName: r.partName } : {}), model: r.model, day: r.day, dayAt: new Date(r.day + 'T00:00:00Z'), i: r.i, cw: r.cw, cr: r.cr, o: r.o, title: meta.title, folder: meta.folder, origin: meta.origin, updatedAt: now, ov, ...(r.acct ? { acct: r.acct } : {}) } },
            upsert: true,
          },
        };
      }) as never,
      { ordered: false },
    );
    if (buckets.length) {
      await c.claudeUsageBuckets.bulkWrite(
        buckets.map(x => ({
          updateOne: {
            filter: { _id: `${deviceId}:${x.sessionId}:${x.part}:${x.model}:${x.at.toISOString()}` },
            update: { $set: { deviceId, sessionId: x.sessionId, part: x.part, model: x.model, at: x.at, acct: x.acct, i: x.i, cw: x.cw, cw1h: x.cw1h, cr: x.cr, o: x.o, n: x.n, ...(x.peakCtx ? { peakCtx: x.peakCtx } : {}), ov, updatedAt: now } },
            upsert: true,
          },
        })) as never,
        { ordered: false },
      );
    }
    if (events.length) {
      // Written once: a repeat of an event (the worker sends it again after a failed report) changes nothing.
      await c.claudeUsageEvents.bulkWrite(
        events.map(e => ({
          updateOne: {
            filter: { _id: `${deviceId}:${e.id}` },
            update: { $setOnInsert: { deviceId, sessionId: e.sessionId, part: e.part, kind: e.kind, at: e.at, acct: e.acct, ...(e.kind === 'limit' ? { which: e.which, resetAt: e.resetAt ?? null } : { trigger: e.trigger, pre: e.pre, post: e.post }), ov, createdAt: now } },
            upsert: true,
          },
        })) as never,
        { ordered: false },
      );
    }
    if (accounts.length) {
      // A label write never fails the report.
      try {
      await c.claudeAccounts.bulkWrite(
        accounts.map(a => ({
          updateOne: {
            filter: { _id: `${s.orgId}:${s.userId}:${a.id}` },
            // An empty label never replaces one already stored.
            update: a.label ? { $set: { id: a.id, label: a.label, lastSeen: now } } : { $set: { id: a.id, lastSeen: now }, $setOnInsert: { label: '' } },
            upsert: true,
          },
        })) as never,
        { ordered: false },
      );
      } catch (err) {
        console.error('[usage] account labels not saved:', err instanceof Error ? err.message : err);
      }
    }
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
  /** The largest context one call of the session's own conversation carried (last 7 days of 5-minute buckets; 0 when none recorded). */
  peakCtx: number;
  subagents: { count: number; weight: number; share: number; items: { id: string; name: string; weight: number; share: number; peakCtx: number; models: UsageSlice[] }[] };
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
  /** Weight per Claude account (its label, else its id; 'Unknown account' for days recorded before accounts were). */
  byAccount: UsageSlice[];
  /** The range's limit hits, newest first (at most 20). */
  limits: { at: string; which: string; resetAt: string | null; account: string; session: string }[];
  /** Compactions in the range: the total and, per session, the count and the average tokens before and after (at most 10 sessions). */
  compactions: { total: number; sessions: { sessionId: string; title: string; count: number; avgPre: number; avgPost: number }[] };
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
  const byAcct = new Map<string, { name: string; weight: number }>();
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
    bump(byAcct, d.acct || 'unknown', d.acct || 'unknown', w);
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

  // Peak context per (computer, session, part) from the 5-minute buckets (the last 7 days): the largest context one call carried.
  const peak = new Map<string, number>();
  try {
    const bks = (await c.claudeUsageBuckets.find({ at: { $gte: new Date(from + 'T00:00:00Z') }, peakCtx: { $gt: 0 } }, { projection: { deviceId: 1, sessionId: 1, part: 1, peakCtx: 1 } }).limit(20000).toArray()) as { deviceId: string; sessionId: string; part: string; peakCtx?: number }[];
    for (const x of bks) { if (revoked.has(x.deviceId)) continue; const k = `${x.deviceId}|${x.sessionId}|${x.part}`; peak.set(k, Math.max(peak.get(k) ?? 0, x.peakCtx ?? 0)); }
  } catch { /* no buckets: no peaks */ }
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
      peakCtx: peak.get(`${deviceId}|${a.meta.sessionId}|main`) ?? 0,
      tokens: a.tokens,
      models: slices(a.models, a.total, 4),
      subagents: {
        count: subs.length,
        weight: Math.round(subWeight),
        share: a.total ? subWeight / a.total : 0,
        items: subs
          .sort((x, y) => y[1].weight - x[1].weight)
          .slice(0, 20)
          .map(([id, p]) => ({ id, name: p.name, weight: Math.round(p.weight), share: total ? p.weight / total : 0, peakCtx: peak.get(`${deviceId}|${a.meta.sessionId}|${id}`) ?? 0, models: slices(p.models, p.weight, 3) })),
      },
      lastDay: a.lastDay,
    });
  }
  bySession.sort((x, y) => y.weight - x.weight);

  // Accounts by label; limit hits and compactions of the range.
  const labelRows = await c.claudeAccounts.find({}, { projection: { id: 1, label: 1 } }).limit(100).toArray();
  const labelOf = new Map(labelRows.map(a => [a.id, a.label]));
  const accountName = (id: string) => (id ? labelOf.get(id) || id : 'Unknown account');
  const byAccount = new Map<string, { name: string; weight: number }>();
  for (const [k, v] of byAcct) bump(byAccount, k, k === 'unknown' ? 'Unknown account' : accountName(k), v.weight);
  const sinceAt = new Date(new Date(from + 'T00:00:00Z').getTime() - 86_400_000);
  const evDocs = ((await c.claudeUsageEvents.find({ at: { $gte: sinceAt } }).sort({ at: -1 }).limit(2000).toArray()) as ClaudeUsageEventDoc[]).filter(e => !revoked.has(e.deviceId) && dateInTz(e.at, opts.tz) >= from);
  const titleOf = new Map<string, string>();
  for (const a of sessions.values()) titleOf.set(a.meta.sessionId, a.meta.title || a.meta.folder);
  const sessionName = (id: string) => titleOf.get(id) || id.slice(0, 8);
  const limits = evDocs
    .filter(e => e.kind === 'limit')
    .slice(0, 20)
    .map(e => ({ at: e.at.toISOString(), which: e.which ?? 'other', resetAt: e.resetAt ? e.resetAt.toISOString() : null, account: accountName(e.acct), session: sessionName(e.sessionId) }));
  const comp = new Map<string, { n: number; pre: number; post: number }>();
  let compTotal = 0;
  for (const e of evDocs) {
    if (e.kind !== 'compact') continue;
    compTotal++;
    const x = comp.get(e.sessionId) ?? { n: 0, pre: 0, post: 0 };
    x.n++;
    x.pre += e.pre ?? 0;
    x.post += e.post ?? 0;
    comp.set(e.sessionId, x);
  }
  const compactions = {
    total: compTotal,
    sessions: [...comp.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10)
      .map(([sessionId, x]) => ({ sessionId, title: sessionName(sessionId), count: x.n, avgPre: Math.round(x.pre / x.n), avgPost: Math.round(x.post / x.n) })),
  };
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
    byAccount: slices(byAccount, total, 10),
    limits,
    compactions,
    hasAny: any,
    updatedAt: updated ? new Date(updated).toISOString() : null,
  };
}
