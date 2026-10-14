import 'server-only';
import { collections } from '../db';
import { describeActivity } from '../activity-text';
import { OPEN_STATUSES, type Activity, type Task } from '../types';
import { addDays, previousWorkdayStart, todayStr, weekStart, APP_TZ } from '../dates';
import { isOverdue, listActivity, sortTasks, toTask, unmetDependencies } from './tasks';
import { projectNameMap } from './projects';

export type Stats = {
  today: string;
  openTotal: number;
  overdue: number;
  dueToday: number;
  inProgress: number;
  blocked: number;
  p1Open: number;
  completedThisWeek: number;
  completedLastWeek: number;
  completedToday: number;
};

export async function getStats(): Promise<Stats> {
  const c = await collections();
  const today = todayStr();
  const ws = weekStart(today);
  const lastWs = addDays(ws, -7);
  const [open, doneRecent] = await Promise.all([
    c.tasks.find({ archived: false, status: { $in: OPEN_STATUSES } }, { projection: { status: 1, due: 1, priority: 1 } }).toArray(),
    c.tasks.find({ status: 'Done', doneOn: { $gte: lastWs } }, { projection: { doneOn: 1 } }).toArray(),
  ]);
  return {
    today,
    openTotal: open.length,
    overdue: open.filter(t => t.due && t.due < today).length,
    dueToday: open.filter(t => t.due === today).length,
    inProgress: open.filter(t => t.status === 'In Progress').length,
    blocked: open.filter(t => t.status === 'Blocked').length,
    p1Open: open.filter(t => t.priority === 'P1').length,
    completedThisWeek: doneRecent.filter(t => t.doneOn! >= ws).length,
    completedLastWeek: doneRecent.filter(t => t.doneOn! < ws).length,
    completedToday: doneRecent.filter(t => t.doneOn === today).length,
  };
}

// ── Morning brief ───────────────────────────────────────────────────────────

/** Compact task shape for summaries and MCP output. */
export type BriefTask = {
  ref: number;
  title: string;
  status: Task['status'];
  priority: Task['priority'];
  project: string | null;
  mode: string | null;
  due: string | null;
  progress: number;
  tags?: string[];
  blockedReason?: string;
  waitingOn?: string[];
  daysOverdue?: number;
  url?: string;
};

export function briefTask(t: Task, names: Map<string, string>, opts: { baseUrl?: string; today?: string } = {}): BriefTask {
  const today = opts.today ?? todayStr();
  const out: BriefTask = {
    ref: t.ref,
    title: t.title,
    status: t.status,
    priority: t.priority,
    project: t.projectId ? (names.get(t.projectId) ?? t.projectId) : null,
    mode: t.mode,
    due: t.due,
    progress: t.progress,
  };
  if (t.tags.length) out.tags = t.tags;
  if (t.blockedReason) out.blockedReason = t.blockedReason;
  if (isOverdue(t, today)) out.daysOverdue = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
  if (opts.baseUrl) out.url = `${opts.baseUrl}/tasks/${t.ref}`;
  return out;
}

export type DailySummary = {
  date: string;
  timezone: string;
  since: string;
  counts: {
    overdue: number;
    dueToday: number;
    inProgress: number;
    blocked: number;
    completedSince: number;
    completedThisWeek: number;
    openTotal: number;
    p1Open: number;
  };
  overdue: BriefTask[];
  dueToday: BriefTask[];
  inProgress: BriefTask[];
  blocked: BriefTask[];
  dueNext7Days: BriefTask[];
  completedSince: (BriefTask & { doneAt: string | null; doneBy: string | null })[];
  changedSince: { ref: number; title: string; events: { at: string; actor: string; type: string; text: string }[] }[];
  projects: { name: string; open: number; overdue: number; doneThisWeek: number }[];
};

export async function dailySummary(opts: { since?: Date; baseUrl?: string } = {}): Promise<DailySummary> {
  const c = await collections();
  const today = todayStr();
  const ws = weekStart(today);
  const since = opts.since ?? previousWorkdayStart(today);
  const names = await projectNameMap(c);

  // Done counts include archived tasks (the work was done); open lists exclude them.
  const [openDocs, doneDocs, doneThisWeek, activity] = await Promise.all([
    c.tasks.find({ archived: false, status: { $in: OPEN_STATUSES } }).toArray(),
    c.tasks.find({ status: 'Done', doneAt: { $gte: since } }).sort({ doneAt: -1 }).toArray(),
    c.tasks.find({ status: 'Done', doneOn: { $gte: ws } }, { projection: { projectId: 1 } }).toArray(),
    listActivity({ since, limit: 300 }),
  ]);
  const open = sortTasks(openDocs.map(toTask));
  const waiting = await unmetDependencies(open);
  const bt = (t: Task) => {
    const b = briefTask(t, names, { baseUrl: opts.baseUrl, today });
    const w = waiting.get(t.id);
    if (w) b.waitingOn = w.map(d => `#${d.ref} ${d.title}`);
    return b;
  };

  const overdue = sortTasks(open.filter(t => isOverdue(t, today)), 'due');
  const dueToday = open.filter(t => t.due === today);
  const inProgress = open.filter(t => t.status === 'In Progress');
  const blocked = open.filter(t => t.status === 'Blocked' || waiting.has(t.id));
  const dueNext7 = sortTasks(open.filter(t => t.due && t.due > today && t.due <= addDays(today, 7)), 'due');

  // Activity since, grouped per task (skip events already reported as completions).
  const grouped = new Map<string, { ref: number; title: string; events: DailySummary['changedSince'][number]['events'] }>();
  for (const a of [...activity].reverse() as Activity[]) {
    const g = grouped.get(a.taskId) ?? { ref: a.taskRef, title: a.taskTitle, events: [] };
    g.events.push({ at: a.at, actor: a.actor, type: a.type, text: describeActivity(a) });
    grouped.set(a.taskId, g);
  }

  const projects = new Map<string, { name: string; open: number; overdue: number; doneThisWeek: number }>();
  const bump = (pid: string | null, k: 'open' | 'overdue' | 'doneThisWeek') => {
    if (!pid) return;
    const p = projects.get(pid) ?? { name: names.get(pid) ?? pid, open: 0, overdue: 0, doneThisWeek: 0 };
    p[k]++;
    projects.set(pid, p);
  };
  for (const t of open) {
    bump(t.projectId, 'open');
    if (isOverdue(t, today)) bump(t.projectId, 'overdue');
  }
  for (const d of doneThisWeek) bump(d.projectId, 'doneThisWeek');

  return {
    date: today,
    timezone: APP_TZ,
    since: since.toISOString(),
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
      completedSince: doneDocs.length,
      completedThisWeek: doneThisWeek.length,
      openTotal: open.length,
      p1Open: open.filter(t => t.priority === 'P1').length,
    },
    overdue: overdue.map(bt),
    dueToday: dueToday.map(bt),
    inProgress: inProgress.map(bt),
    blocked: blocked.map(bt),
    dueNext7Days: dueNext7.slice(0, 20).map(bt),
    completedSince: doneDocs.map(d => {
      const t = toTask(d);
      return { ...briefTask(t, names, { baseUrl: opts.baseUrl, today }), doneAt: t.doneAt, doneBy: t.doneBy };
    }),
    changedSince: [...grouped.values()].slice(0, 60),
    projects: [...projects.values()].sort((a, b) => b.open - a.open),
  };
}
