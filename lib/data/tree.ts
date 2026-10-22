import 'server-only';
import { toActivity } from '../db';
import { scoped, type Scope } from '../scope';
import { OPEN_STATUSES, type Activity, type Task } from '../types';
import { NotFoundError } from './errors';
import { getProjectWithStats } from './projects';
import type { ProjectWithStats } from '../types';
import { sortTasks, toTask, unmetDependencies } from './tasks';

// One read for "the whole picture of a project", at a chosen depth:
//   project → + project-wide recent activity
//   tasks   → + its tasks (open by default)
//   full    → + per task: checklist, dependencies and recent history

export type TreeDepth = 'project' | 'tasks' | 'full';

export type ProjectTree = {
  project: ProjectWithStats;
  recentActivity: Activity[];
  tasks?: (Task & { waitingOn?: { ref: number; title: string }[]; activity?: Activity[] })[];
  closedOmitted?: number;
};

export async function getProjectTree(
  s: Scope,
  nameOrId: string,
  opts: { depth?: TreeDepth; includeClosed?: boolean; activityPerTask?: number; recentActivity?: number } = {},
): Promise<ProjectTree> {
  const depth = opts.depth ?? 'tasks';
  const project = await getProjectWithStats(s, nameOrId);
  if (!project) throw new NotFoundError(`Project "${nameOrId}" not found`);
  const c = await scoped(s);

  const all = (await c.tasks.find({ projectId: project.id, archived: false }).toArray()).map(toTask);
  const ids = all.map(t => t.id);
  const recent = ids.length
    ? (await c.activity.find({ taskId: { $in: ids } }).sort({ at: -1 }).limit(opts.recentActivity ?? 15).toArray()).map(toActivity)
    : [];
  const tree: ProjectTree = { project, recentActivity: recent };
  if (depth === 'project') return tree;

  const shown = sortTasks(opts.includeClosed ? all : all.filter(t => OPEN_STATUSES.includes(t.status)), 'priority');
  const waiting = await unmetDependencies(s, shown);
  let perTask = new Map<string, Activity[]>();
  if (depth === 'full' && shown.length) {
    const n = Math.min(Math.max(opts.activityPerTask ?? 5, 1), 30);
    const rows = await c.activity
      .find({ taskId: { $in: shown.map(t => t.id) } })
      .sort({ at: -1 })
      .limit(n * shown.length)
      .toArray();
    perTask = new Map();
    for (const r of rows) {
      const list = perTask.get(r.taskId) ?? [];
      if (list.length < n) list.push(toActivity(r));
      perTask.set(r.taskId, list);
    }
  }
  tree.tasks = shown.map(t => ({
    ...t,
    ...(waiting.get(t.id) ? { waitingOn: waiting.get(t.id)!.map(d => ({ ref: d.ref, title: d.title })) } : {}),
    ...(depth === 'full' ? { activity: perTask.get(t.id) ?? [] } : {}),
  }));
  if (!opts.includeClosed) tree.closedOmitted = all.length - shown.length;
  return tree;
}
