import 'server-only';
import { collections } from '../db';
import { currentTz, dateInTz } from '../dates';
import { hourKey, type UsageCaller, type UsageKind } from '../usage';

// Reads the request log (lib/usage.ts) for Settings › Usage.

export type UsageRow = { route: string; total: number; parts: { kind: UsageKind; caller: UsageCaller; n: number }[] };
export type UsageRange = {
  total: number;
  byKind: Record<string, number>;
  byCaller: Record<string, number>;
  routes: UsageRow[];
};
export type UsageReport = {
  hours: { key: string; label: string; n: number }[]; // last 24 hours, oldest first
  days: { date: string; label: string; n: number }[]; // last 7 days in the viewer's timezone, oldest first
  day: UsageRange; // last 24 h
  week: UsageRange; // last 7 days
  since: string | null; // first bucket kept
};

const HOUR = 3_600_000;

function range(docs: { counts?: Record<string, number> }[]): UsageRange {
  const byKind: Record<string, number> = {};
  const byCaller: Record<string, number> = {};
  const routes = new Map<string, UsageRow>();
  let total = 0;
  for (const d of docs) {
    for (const [key, n] of Object.entries(d.counts ?? {})) {
      const [kind, caller, route] = key.split('|') as [UsageKind, UsageCaller, string];
      if (!route) continue;
      total += n;
      byKind[kind] = (byKind[kind] ?? 0) + n;
      byCaller[caller] = (byCaller[caller] ?? 0) + n;
      const row = routes.get(route) ?? { route, total: 0, parts: [] };
      row.total += n;
      const part = row.parts.find(p => p.kind === kind && p.caller === caller);
      if (part) part.n += n;
      else row.parts.push({ kind, caller, n });
      routes.set(route, row);
    }
  }
  const rows = [...routes.values()].sort((a, b) => b.total - a.total || a.route.localeCompare(b.route));
  for (const r of rows) r.parts.sort((a, b) => b.n - a.n);
  return { total, byKind, byCaller, routes: rows };
}

export async function usageReport(now = new Date()): Promise<UsageReport> {
  const { requestStats } = await collections(); // scope-ok: request counters for the whole app (no organization data)
  const thisHour = Math.floor(now.getTime() / HOUR) * HOUR;
  const weekStart = thisHour - (7 * 24 - 1) * HOUR;
  const dayStart = thisHour - 23 * HOUR;
  const [docs, first] = await Promise.all([
    requestStats.find({ _id: { $gte: hourKey(new Date(weekStart)) } }).toArray(),
    requestStats.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next(),
  ]);
  const byId = new Map(docs.map(d => [d._id, d]));

  const tz = currentTz();
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const hours = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(dayStart + i * HOUR);
    return { key: hourKey(t), label: hourFmt.format(t), n: byId.get(hourKey(t))?.total ?? 0 };
  });

  // Days in the viewer's timezone: each UTC hour bucket goes to the local day its start falls on.
  const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const today = dateInTz(now);
  const days = new Map<string, { date: string; label: string; n: number }>();
  for (let i = 6; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 24 * HOUR);
    const date = dateInTz(t);
    days.set(date, { date, label: date === today ? 'Today' : dayFmt.format(t), n: 0 });
  }
  for (const d of docs) {
    const day = days.get(dateInTz(new Date(`${d._id}:00:00Z`)));
    if (day) day.n += d.total ?? 0;
  }

  return {
    hours,
    days: [...days.values()],
    day: range(docs.filter(d => d._id >= hourKey(new Date(dayStart)))),
    week: range(docs),
    since: first?._id ?? null,
  };
}
