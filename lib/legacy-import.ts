import 'server-only';
import type { AnyBulkWriteOperation } from 'mongodb';
import type { ActivityDoc, Collections, ProjectDoc, TaskDoc } from './db';
import type { Mode, Priority, Status } from './types';

// Imports the old local data/tasks.json into MongoDB.
// Safe to re-run: deterministic _ids, upserts, existing task refs kept, tasks already
// in the DB are never overwritten (so edits made in the new app survive).

type LegacyTask = {
  id: string;
  task: string;
  mode?: Mode;
  projectClient?: string;
  priority?: Priority;
  estimateMins?: number;
  due?: string;
  status?: Status;
  addedOn?: string;
  lastTouched?: string;
  doneDate?: string;
  notes?: string;
};
type LegacyReview = { id: string } & Record<string, unknown>;
type LegacyRitual = { id: string; date: string } & Record<string, unknown>;
export type LegacyData = { tasks?: LegacyTask[]; reviews?: LegacyReview[]; ritualLogs?: LegacyRitual[] };

export type ImportReport = {
  dryRun: boolean;
  source: { tasks: number; reviews: number; ritualLogs: number };
  projects: { id: string; name: string; tasks: number; isNew: boolean }[];
  tasks: { total: number; new: number; alreadyInDb: number };
  activityEntries: number;
  verified?: { tasks: number; reviews: number; ritualLogs: number };
  problems: string[];
};

const at = (d: string) => new Date(`${d}T12:00:00Z`);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
// "Eric / Grant Leads" and "grant leads / eric" are the same project.
const projectKey = (s: string) => s.split('/').map(p => p.trim().toLowerCase()).filter(Boolean).sort().join(' / ');

export async function importLegacy(c: Collections, source: LegacyData, opts: { dryRun: boolean }): Promise<ImportReport> {
  const srcTasks = (source.tasks ?? []).filter(t => t && typeof t.id === 'string' && typeof t.task === 'string');
  const srcReviews = source.reviews ?? [];
  const srcRituals = source.ritualLogs ?? [];
  const problems: string[] = [];
  if (srcTasks.length !== (source.tasks ?? []).length) problems.push('some source tasks were missing id/task and were skipped');

  // ── Projects ──────────────────────────────────────────────────────────────
  const byKey = new Map<string, { name: string; count: number; firstSeen: string }>();
  for (const t of srcTasks) {
    const name = (t.projectClient ?? '').trim();
    if (!name) continue;
    const key = projectKey(name);
    const p = byKey.get(key);
    if (!p) byKey.set(key, { name, count: 1, firstSeen: isDate(t.addedOn) ? t.addedOn : '2026-01-01' });
    else {
      p.count++;
      if (p.name === p.name.toLowerCase() && name !== name.toLowerCase()) p.name = name;
    }
  }
  const existingProjects = await c.projects.find({}).toArray();
  const usedIds = new Set(existingProjects.map(p => p._id));
  const projectIdByKey = new Map<string, string>();
  const newProjects: ProjectDoc[] = [];
  const projectReport: ImportReport['projects'] = [];
  for (const [key, p] of byKey) {
    const existing = existingProjects.find(e => projectKey(e.name) === key || e.nameLower === p.name.toLowerCase());
    if (existing) {
      projectIdByKey.set(key, existing._id);
      projectReport.push({ id: existing._id, name: existing.name, tasks: p.count, isNew: false });
      continue;
    }
    let id = slugify(p.name);
    for (let i = 2; usedIds.has(id); i++) id = `${slugify(p.name)}-${i}`;
    usedIds.add(id);
    projectIdByKey.set(key, id);
    newProjects.push({
      _id: id,
      name: p.name,
      nameLower: p.name.toLowerCase(),
      client: '',
      description: '',
      status: 'active',
      createdAt: at(p.firstSeen),
      updatedAt: new Date(),
    });
    projectReport.push({ id, name: p.name, tasks: p.count, isNew: true });
  }

  // ── Tasks + activity ──────────────────────────────────────────────────────
  const existingRefs = new Map(
    (await c.tasks.find({}, { projection: { ref: 1 } }).toArray()).map(t => [t._id, t.ref] as const),
  );
  const counter = await c.counters.findOne({ _id: 'task' });
  let nextRef = Math.max(counter?.seq ?? 0, 0, ...existingRefs.values());

  const ordered = srcTasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.addedOn ?? '').localeCompare(b.t.addedOn ?? '') || a.i - b.i);
  const taskDocs: TaskDoc[] = [];
  const activityDocs: ActivityDoc[] = [];
  for (const { t } of ordered) {
    const ref = existingRefs.get(t.id) ?? ++nextRef;
    const name = (t.projectClient ?? '').trim();
    const status: Status = t.status ?? 'Not Started';
    const done = status === 'Done';
    const addedOn = isDate(t.addedOn) ? t.addedOn : '2026-01-01';
    const lastTouched = isDate(t.lastTouched) ? t.lastTouched : addedOn;
    const doneOn = done ? (isDate(t.doneDate) ? t.doneDate : lastTouched) : null;
    const doc: TaskDoc = {
      _id: t.id,
      ref,
      title: t.task,
      description: t.notes ?? '',
      mode: t.mode ?? null,
      projectId: name ? (projectIdByKey.get(projectKey(name)) ?? null) : null,
      priority: t.priority ?? 'P2',
      status,
      tags: [],
      due: isDate(t.due) ? t.due : null,
      start: null,
      estimateMins: typeof t.estimateMins === 'number' ? t.estimateMins : null,
      progress: done ? 100 : status === 'In Progress' ? 10 : 0,
      checklist: [],
      links: [],
      blockedReason: '',
      dependsOn: [],
      recurrence: null,
      nextRef: null,
      archived: false,
      createdBy: 'me',
      createdAt: at(addedOn),
      updatedAt: at(lastTouched),
      doneAt: doneOn ? at(doneOn) : null,
      doneOn,
      doneBy: done ? 'me' : null,
    };
    taskDocs.push(doc);

    const base = { taskId: doc._id, taskRef: ref, taskTitle: doc.title, actor: 'me' as const };
    activityDocs.push({ _id: `import-created-${doc._id}`, ...base, at: doc.createdAt, type: 'created', note: 'Imported from tasks.json' });
    if (done) {
      activityDocs.push({ _id: `import-done-${doc._id}`, ...base, at: doc.doneAt!, type: 'completed', changes: { status: { from: null, to: 'Done' } } });
    } else if (status !== 'Not Started') {
      activityDocs.push({
        _id: `import-status-${doc._id}`,
        ...base,
        at: doc.updatedAt,
        type: 'status',
        changes: { status: { from: 'Not Started', to: status } },
      });
    }
  }
  const newTasks = taskDocs.filter(d => !existingRefs.has(d._id));

  const report: ImportReport = {
    dryRun: opts.dryRun,
    source: { tasks: srcTasks.length, reviews: srcReviews.length, ritualLogs: srcRituals.length },
    projects: projectReport,
    tasks: { total: taskDocs.length, new: newTasks.length, alreadyInDb: taskDocs.length - newTasks.length },
    activityEntries: activityDocs.length,
    problems,
  };
  if (opts.dryRun) return report;

  // ── Write ─────────────────────────────────────────────────────────────────
  const replaceOps = <T extends { _id: string }>(docs: T[]): AnyBulkWriteOperation<T>[] =>
    docs.map(d => ({ replaceOne: { filter: { _id: d._id } as never, replacement: d, upsert: true } }));
  if (newProjects.length) await c.projects.bulkWrite(replaceOps(newProjects));
  if (newTasks.length) await c.tasks.bulkWrite(replaceOps(newTasks));
  if (activityDocs.length) {
    await c.activity.bulkWrite(
      activityDocs.map(d => ({ updateOne: { filter: { _id: d._id }, update: { $setOnInsert: d }, upsert: true } })),
    );
  }
  if (srcReviews.length) {
    await c.reviews.bulkWrite(
      srcReviews.map(({ id, ...r }) => ({ replaceOne: { filter: { _id: id }, replacement: { _id: id, ...r } as never, upsert: true } })),
    );
  }
  if (srcRituals.length) {
    await c.ritualLogs.bulkWrite(
      srcRituals.map(({ id, ...r }) => ({ replaceOne: { filter: { _id: id }, replacement: { _id: id, ...r } as never, upsert: true } })),
    );
  }
  await c.counters.updateOne({ _id: 'task' }, { $max: { seq: nextRef } }, { upsert: true });

  // ── Verify ────────────────────────────────────────────────────────────────
  const inDb = new Map((await c.tasks.find({ _id: { $in: srcTasks.map(t => t.id) } }).toArray()).map(d => [d._id, d]));
  for (const t of srcTasks) {
    const d = inDb.get(t.id);
    if (!d) {
      problems.push(`missing ${t.id} "${t.task}"`);
      continue;
    }
    if (existingRefs.has(t.id)) continue; // may have been edited since an earlier import
    if (d.title !== t.task) problems.push(`title mismatch ${t.id}`);
    if (d.status !== (t.status ?? 'Not Started')) problems.push(`status mismatch ${t.id}`);
    if ((d.due ?? '') !== (isDate(t.due) ? t.due : '')) problems.push(`due mismatch ${t.id}`);
    if (d.description !== (t.notes ?? '')) problems.push(`notes mismatch ${t.id}`);
  }
  const reviews = await c.reviews.countDocuments({ _id: { $in: srcReviews.map(r => r.id) } });
  const ritualLogs = await c.ritualLogs.countDocuments({ _id: { $in: srcRituals.map(r => r.id) } });
  if (reviews !== srcReviews.length) problems.push(`reviews: ${reviews}/${srcReviews.length}`);
  if (ritualLogs !== srcRituals.length) problems.push(`ritual logs: ${ritualLogs}/${srcRituals.length}`);
  report.verified = { tasks: inDb.size, reviews, ritualLogs };
  return report;
}
