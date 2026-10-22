import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { requestContext } from '../request-context';
import { nextSeq, toActivity, type ActivityDoc, type ClaudeMark, type TaskDoc, type TrashDoc } from '../db';
import { canSee, orgWide, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import { asActor, isPerson, actorUserId, type ActorFilter } from '../actors';
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  TaskInputSchema,
  TaskPatchSchema,
  type Activity,
  type ActivityType,
  type Actor,
  type ChecklistItem,
  type FieldChange,
  type Link,
  type Mode,
  type Priority,
  type Project,
  type Recurrence,
  type Status,
  type Task,
  type TaskClaude,
  type TaskInput,
  type TaskPatch,
  type TaskSource,
} from '../types';
import { addDays, addMonths, resolveDate, todayStr, weekday, weekStart } from '../dates';
import { placeIn, placeNotes, placeTasks, resolveProject, toProject, type Placement } from './projects';
import { InputError, NotFoundError } from './errors';
import { queueUnblocked } from '../alerts';
import { onTaskChanged, takeBackOnEdit } from './dispatcher';

// ── Conversions & helpers ───────────────────────────────────────────────────

export function toTask(d: TaskDoc): Task {
  return {
    id: d._id,
    ref: d.ref,
    title: d.title,
    description: d.description,
    mode: d.mode,
    projectId: d.projectId,
    priority: d.priority,
    status: d.status,
    tags: d.tags,
    due: d.due,
    start: d.start,
    estimateMins: d.estimateMins,
    progress: d.progress,
    checklist: d.checklist,
    links: d.links,
    blockedReason: d.blockedReason,
    dependsOn: d.dependsOn,
    recurrence: d.recurrence,
    nextRef: d.nextRef,
    archived: d.archived,
    createdBy: asActor(d.createdBy),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    doneAt: d.doneAt ? d.doneAt.toISOString() : null,
    doneOn: d.doneOn,
    doneBy: d.doneBy ? asActor(d.doneBy) : null,
    ...(d.source ? { source: d.source } : {}),
    ...(d.claude ? { claude: toTaskClaude(d.claude) } : {}),
    ownerId: d.ownerId,
    visibility: d.visibility,
    assigneeId: d.assigneeId ?? null,
  };
}

function toTaskClaude(m: ClaudeMark): TaskClaude {
  return {
    state: m.state,
    markedAt: m.markedAt.toISOString(),
    ...(m.folderKey ? { folderKey: m.folderKey } : {}),
    ...(m.sessionId ? { sessionId: m.sessionId } : {}),
    ...(m.deviceId ? { deviceId: m.deviceId } : {}),
    ...(m.claimedAt ? { claimedAt: m.claimedAt.toISOString() } : {}),
    ...(m.endedAt ? { endedAt: m.endedAt.toISOString() } : {}),
    ...(m.note ? { note: m.note } : {}),
  };
}

export function isOpen(status: Status): boolean {
  return !CLOSED_STATUSES.includes(status);
}

export function isOverdue(t: Pick<Task, 'due' | 'status'>, today: string = todayStr()): boolean {
  return !!t.due && t.due < today && isOpen(t.status);
}

/**
 * Who gets a task's alerts and notices (docs/multi-user.md "Inbox, push, alerts"): its assignee when set and the task
 * is shared (a private task is seen only by its owner), else its owner.
 */
export function recipientOf(t: Pick<TaskDoc, 'ownerId' | 'visibility' | 'assigneeId'>): string {
  return t.assigneeId && t.visibility === 'org' ? t.assigneeId : t.ownerId;
}

/** The query form of recipientOf: tasks whose alerts go to this person. */
export function recipientFilter(userId: string): Filter<TaskDoc> {
  return { $or: [{ assigneeId: userId, visibility: 'org' }, { ownerId: userId, $or: [{ assigneeId: null }, { assigneeId: { $exists: false } }, { visibility: 'private' }] }] };
}

/** Accepts a task id, a number, or "#12" / "12". */
function taskKeyFilter(key: string | number): Filter<TaskDoc> {
  if (typeof key === 'number') return { ref: key };
  const s = key.trim();
  const m = s.match(/^#?(\d{1,7})$/);
  if (m) return { ref: Number(m[1]) };
  return { _id: s };
}

async function findTaskDoc(c: Collections, key: string | number): Promise<TaskDoc> {
  const doc = await c.tasks.findOne(taskKeyFilter(key));
  if (!doc) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : `"${key}"`} not found`);
  return doc;
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const t of tags) {
    const v = t.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (v) out.add(v);
  }
  return [...out];
}

function normalizeChecklist(
  items: (string | { text: string; done?: boolean })[] | undefined,
  existing: ChecklistItem[] = [],
): ChecklistItem[] {
  if (!items) return [];
  return items.map(it => {
    const text = typeof it === 'string' ? it.trim() : it.text.trim();
    const prev = existing.find(e => e.text === text);
    const done = typeof it === 'string' ? (prev?.done ?? false) : (it.done ?? prev?.done ?? false);
    return { id: prev?.id ?? shortId(), text, done };
  });
}

function normalizeUrl(u: string): string {
  const s = u.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return 'https://' + s;
}

function normalizeLinks(links: (string | { url: string; label?: string })[] | undefined): Link[] {
  if (!links) return [];
  return links.map(l =>
    typeof l === 'string' ? { url: normalizeUrl(l), label: '' } : { url: normalizeUrl(l.url), label: l.label?.trim() ?? '' },
  );
}

function dateField(value: string | null | undefined, field: string): string | null {
  const r = resolveDate(value ?? null);
  if (r === undefined) throw new InputError(`Couldn't read ${field} date "${value}". Use YYYY-MM-DD, today, tomorrow, a weekday name or +3d.`);
  return r;
}

async function resolveDependencies(c: Collections, deps: (string | number)[] | undefined, selfId?: string): Promise<string[]> {
  if (!deps?.length) return [];
  const ids: string[] = [];
  for (const d of deps) {
    const doc = await c.tasks.findOne(taskKeyFilter(d), { projection: { _id: 1 } });
    if (!doc) throw new InputError(`Dependency ${d} not found`);
    if (doc._id !== selfId && !ids.includes(doc._id)) ids.push(doc._id);
  }
  return ids;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Keep activity entries small: long text and lists are summarised. */
function compactValue(field: string, v: unknown): unknown {
  if (v == null) return null;
  if (field === 'description' && typeof v === 'string') return v.length > 280 ? v.slice(0, 277) + '…' : v;
  if (field === 'checklist' && Array.isArray(v)) return (v as ChecklistItem[]).map(i => (i.done ? '[x] ' : '[ ] ') + i.text);
  if (field === 'links' && Array.isArray(v)) return (v as Link[]).map(l => l.label || l.url);
  return v;
}

async function logActivity(
  c: Collections,
  task: Pick<TaskDoc, '_id' | 'ref' | 'title' | 'orgId' | 'ownerId' | 'visibility'>,
  actor: Actor,
  type: ActivityType,
  extra: { changes?: Record<string, FieldChange>; note?: string; at?: Date } = {},
): Promise<ActivityDoc> {
  // History entries are seen by whoever sees the task.
  const doc: ActivityDoc = {
    _id: randomUUID(),
    orgId: task.orgId,
    ownerId: task.ownerId,
    visibility: task.visibility,
    taskId: task._id,
    taskRef: task.ref,
    taskTitle: task.title,
    at: extra.at ?? new Date(),
    actor,
    type,
  };
  if (extra.changes && Object.keys(extra.changes).length) doc.changes = extra.changes;
  if (extra.note?.trim()) doc.note = extra.note.trim();
  const rc = requestContext();
  if (rc.session) doc.session = rc.session;
  if (rc.repo) doc.repo = rc.repo;
  await c.activity.insertOne(doc);
  return doc;
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createTask(
  s: Scope,
  input: TaskInput,
  actor: Actor,
  opts: { note?: string; source?: TaskSource } = {},
): Promise<Task> {
  const data = TaskInputSchema.parse(input);
  const c = await scoped(s);
  return toTask(await insertTask(c, s, data, actor, { note: opts.note, source: opts.source }));
}

/** The task already created from this external message, if any. */
export async function findTaskBySourceMessage(s: Scope, messageId: string): Promise<Task | null> {
  const c = await scoped(s);
  const d = await c.tasks.findOne({ 'source.messageId': messageId });
  return d ? toTask(d) : null;
}

/** Task numbers (#12) count per organization. */
export const taskCounter = (s: Scope) => `task:${s.orgId}`;

async function insertTask(
  c: Collections,
  s: Scope,
  data: ReturnType<typeof TaskInputSchema.parse>,
  actor: Actor,
  opts: { note?: string; source?: TaskSource; ownerId?: string } = {},
): Promise<TaskDoc> {
  const now = new Date();
  const today = todayStr();
  const project = data.project ? await resolveProject(c, s, data.project, { create: true }) : null;
  const status: Status = data.status ?? (data.blockedReason?.trim() ? 'Blocked' : 'Not Started');
  const done = status === 'Done';
  const id = randomUUID();
  const doc: TaskDoc = {
    _id: id,
    orgId: s.orgId,
    ...placeIn(project, opts.ownerId ?? s.userId),
    ref: await nextSeq(c.counters, taskCounter(s)),
    title: data.title,
    description: data.description ?? '',
    mode: data.mode ?? null,
    projectId: project?._id ?? null,
    priority: data.priority ?? 'P2',
    status,
    tags: normalizeTags(data.tags),
    due: dateField(data.due, 'due'),
    start: dateField(data.start, 'start'),
    estimateMins: data.estimateMins ?? null,
    progress: done ? 100 : (data.progress ?? 0),
    checklist: normalizeChecklist(data.checklist),
    links: normalizeLinks(data.links),
    blockedReason: data.blockedReason?.trim() ?? '',
    dependsOn: await resolveDependencies(c, data.dependsOn, id),
    recurrence: data.recurrence ?? null,
    nextRef: null,
    archived: false,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
    doneAt: done ? now : null,
    doneOn: done ? today : null,
    doneBy: done ? actor : null,
    ...(opts.source ? { source: opts.source } : {}),
  };
  await c.tasks.insertOne(doc);
  await logActivity(c, doc, actor, 'created', { note: opts.note });
  return doc;
}

export async function bulkCreateTasks(s: Scope, inputs: TaskInput[], actor: Actor): Promise<Task[]> {
  const out: Task[] = [];
  for (const i of inputs) out.push(await createTask(s, i, actor));
  return out;
}

// ── Update ──────────────────────────────────────────────────────────────────

type UpdateOpts = {
  note?: string;
  /** 'progress' logs the change as a progress update rather than an edit. */
  kind?: 'progress';
};

export async function updateTask(s: Scope, key: string | number, patch: TaskPatch, actor: Actor, opts: UpdateOpts = {}): Promise<Task> {
  const data = TaskPatchSchema.parse(patch);
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  const now = new Date();
  const set: Partial<TaskDoc> = {};
  const changes: Record<string, FieldChange> = {};

  const apply = <K extends keyof TaskDoc>(field: K, value: TaskDoc[K], label: string = field) => {
    if (same(cur[field], value)) return;
    set[field] = value;
    changes[label] = { from: compactValue(label, cur[field]), to: compactValue(label, value) };
  };

  if (data.title !== undefined) apply('title', data.title);
  if (data.description !== undefined) apply('description', data.description);
  if (data.mode !== undefined) apply('mode', data.mode ?? null);
  if (data.priority !== undefined) apply('priority', data.priority);
  if (data.tags !== undefined) apply('tags', normalizeTags(data.tags));
  if (data.due !== undefined) apply('due', dateField(data.due, 'due'));
  if (data.start !== undefined) apply('start', dateField(data.start, 'start'));
  if (data.estimateMins !== undefined) apply('estimateMins', data.estimateMins ?? null);
  if (data.checklist !== undefined) apply('checklist', normalizeChecklist(data.checklist, cur.checklist));
  if (data.links !== undefined) apply('links', normalizeLinks(data.links));
  if (data.dependsOn !== undefined) apply('dependsOn', await resolveDependencies(c, data.dependsOn, cur._id));
  if (data.recurrence !== undefined) apply('recurrence', data.recurrence ?? null);

  let moveTo: Placement | null = null;
  if (data.project !== undefined) {
    const p = data.project ? await resolveProject(c, s, data.project, { create: true }) : null;
    if ((p?._id ?? null) !== cur.projectId) {
      const old = cur.projectId ? await c.projects.findOne({ _id: cur.projectId }, { projection: { name: 1 } }) : null;
      set.projectId = p?._id ?? null;
      changes.project = { from: old?.name ?? cur.projectId, to: p?.name ?? null };
      // The task follows its project. Taking a shared task out of the shared space is its owner's call.
      const place = placeIn(p, cur.ownerId);
      if (cur.visibility === 'org' && place.visibility === 'private' && cur.ownerId !== s.userId) {
        throw new InputError(`Only the task's owner can take #${cur.ref} out of a shared project`);
      }
      if (place.ownerId !== cur.ownerId || place.visibility !== cur.visibility) moveTo = place;
    }
  }

  // Status and its side effects.
  let status: Status = data.status ?? cur.status;
  const reason = data.blockedReason?.trim();
  if (data.status === undefined && reason && isOpen(cur.status) && cur.status !== 'Blocked') status = 'Blocked';
  // A blocked reason wins over "progress means started".
  if (data.status === undefined && status === cur.status && data.progress !== undefined && data.progress > 0 && cur.status === 'Not Started') {
    status = 'In Progress';
  }
  if (reason !== undefined) apply('blockedReason', reason);
  else if (cur.status === 'Blocked' && status !== 'Blocked' && cur.blockedReason) apply('blockedReason', '');

  const statusChanged = status !== cur.status;
  if (statusChanged) {
    apply('status', status);
    if (status === 'Done') {
      set.doneAt = now;
      set.doneOn = todayStr();
      set.doneBy = actor;
      if (data.progress === undefined) apply('progress', 100);
    } else if (cur.status === 'Done') {
      set.doneAt = null;
      set.doneOn = null;
      set.doneBy = null;
    }
    // Reopening: don't leave progress at 100%. Restore what it was before completion.
    if (CLOSED_STATUSES.includes(cur.status) && isOpen(status) && data.progress === undefined && cur.progress >= 100) {
      apply('progress', status === 'Not Started' ? 0 : await progressBeforeCompletion(c, cur._id));
    }
  }
  if (data.progress !== undefined) apply('progress', data.progress);

  const hasChanges = Object.keys(changes).length > 0;
  if (!hasChanges) {
    if (opts.note?.trim()) {
      await logActivity(c, cur, actor, opts.kind === 'progress' ? 'progress' : 'comment', { note: opts.note });
      await c.tasks.updateOne({ _id: cur._id }, { $set: { updatedAt: now } });
      await takeBackOnEdit(s, cur, actor);
      return toTask({ ...cur, updatedAt: now });
    }
    return toTask(cur);
  }

  set.updatedAt = now;
  await c.tasks.updateOne({ _id: cur._id }, { $set: set });
  if (moveTo) await placeTasks(c, [cur._id], moveTo);
  const next: TaskDoc = { ...cur, ...set, ...(moveTo ?? {}) };

  // History: a status transition gets its own entry; other field changes are grouped.
  const statusKeys = ['status', 'blockedReason', 'progress'];
  if (statusChanged) {
    const type: ActivityType =
      status === 'Done' ? 'completed' : CLOSED_STATUSES.includes(cur.status) && isOpen(status) ? 'reopened' : 'status';
    const statusChanges = Object.fromEntries(Object.entries(changes).filter(([k]) => statusKeys.includes(k)));
    const rest = Object.fromEntries(Object.entries(changes).filter(([k]) => !statusKeys.includes(k)));
    await logActivity(c, next, actor, type, { changes: statusChanges, note: opts.note });
    if (Object.keys(rest).length) await logActivity(c, next, actor, 'edit', { changes: rest });
  } else {
    const onlyProgress = Object.keys(changes).every(k => k === 'progress');
    const type: ActivityType = opts.kind === 'progress' || onlyProgress ? 'progress' : 'edit';
    await logActivity(c, next, actor, type, { changes, note: opts.note });
  }

  if (statusChanged && CLOSED_STATUSES.includes(status) && isOpen(cur.status)) await queueUnblocked(s, next);
  // Someone else changed what Claude reads: take it back from Claude (docs/dispatcher.md).
  if (changes.title || changes.description || newChecklistText(cur.checklist, next.checklist) || opts.note?.trim()) {
    if (await takeBackOnEdit(s, next, actor)) next.claude = (await c.tasks.findOne({ _id: cur._id }, { projection: { claude: 1 } }))?.claude ?? next.claude;
  }
  // A task someone gave to Claude: Done or Blocked ends the dispatcher's run (docs/dispatcher.md).
  if (statusChanged && next.claude?.state === 'running') await onTaskChanged(c, s, next);
  if (statusChanged && status === 'Done' && next.recurrence && !next.nextRef) {
    next.nextRef = await spawnNextOccurrence(c, s, next, actor);
  }
  return toTask(next);
}

async function progressBeforeCompletion(c: Collections, taskId: string): Promise<number> {
  const done = await c.activity.findOne({ taskId, type: 'completed', 'changes.progress.from': { $type: 'number' } }, { sort: { at: -1 } });
  const from = done?.changes?.progress?.from;
  return typeof from === 'number' && from < 100 ? from : 0;
}

export async function logProgress(
  s: Scope,
  key: string | number,
  progress: number,
  note: string | undefined,
  actor: Actor,
  status?: Status,
  blockedReason?: string,
): Promise<Task> {
  return updateTask(s, key, { progress, ...(status ? { status } : {}), ...(blockedReason !== undefined ? { blockedReason } : {}) }, actor, { note, kind: 'progress' });
}

export async function completeTask(s: Scope, key: string | number, note: string | undefined, actor: Actor): Promise<Task> {
  return updateTask(s, key, { status: 'Done' }, actor, { note });
}

export async function addComment(s: Scope, key: string | number, note: string, actor: Actor): Promise<Task> {
  if (!note.trim()) throw new InputError('Note is empty');
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  const now = new Date();
  await c.tasks.updateOne({ _id: cur._id }, { $set: { updatedAt: now } });
  await logActivity(c, cur, actor, 'comment', { note });
  await takeBackOnEdit(s, cur, actor);
  return toTask({ ...cur, updatedAt: now });
}

export async function setArchived(s: Scope, key: string | number, archived: boolean, actor: Actor): Promise<Task> {
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  if (cur.archived === archived) return toTask(cur);
  const now = new Date();
  await c.tasks.updateOne({ _id: cur._id }, { $set: { archived, updatedAt: now } });
  await logActivity(c, cur, actor, archived ? 'archived' : 'unarchived');
  return toTask({ ...cur, archived, updatedAt: now });
}

// ── Delete (trash), restore ─────────────────────────────────────────────────
// Deleting moves the task and its history into `trash` for 30 days; nothing else needs
// a "deleted" filter. `expectTitle` guards against deleting the wrong ref by typo.

export const TRASH_DAYS = 30;

function titleMatches(actual: string, expected: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(actual);
  const e = norm(expected);
  return !!e && (a === e || (e.length >= 8 && a.startsWith(e)) || (e.length >= 12 && a.includes(e)));
}

export async function trashTask(
  s: Scope,
  key: string | number,
  actor: Actor,
  opts: { reason?: string; expectTitle?: string } = {},
): Promise<{ ref: number; title: string }> {
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  if (opts.expectTitle !== undefined && !titleMatches(cur.title, opts.expectTitle)) {
    throw new InputError(`#${cur.ref} is "${cur.title}", not "${opts.expectTitle}". Nothing deleted.`);
  }
  const activity = await c.activity.find({ taskId: cur._id }).toArray();
  const notes = await c.notes.find({ taskId: cur._id, deletedAt: null }, { projection: { _id: 1 } }).toArray();
  // A restored task must not come back queued for Claude: Om marks again if he wants it.
  const { claude: _claude, ...plain } = cur;
  void _claude;
  const doc: TrashDoc = {
    _id: cur._id,
    orgId: cur.orgId,
    ownerId: cur.ownerId,
    visibility: cur.visibility,
    ref: cur.ref,
    title: cur.title,
    task: plain,
    activity,
    deletedAt: new Date(),
    deletedBy: actor,
    reason: opts.reason?.trim() ?? '',
    ...(notes.length ? { noteIds: notes.map(n => n._id) } : {}),
  };
  if (notes.length) await c.notes.updateMany({ _id: { $in: notes.map(n => n._id) } }, { $set: { deletedAt: doc.deletedAt, deletedBy: actor } });
  await c.trash.replaceOne({ _id: cur._id }, doc, { upsert: true });
  await c.tasks.deleteOne({ _id: cur._id });
  await c.activity.deleteMany({ taskId: cur._id });
  // One line stays in the feed so "who deleted what" shows in History and recent_activity.
  await logActivity(c, cur, actor, 'trashed', { note: opts.reason });
  // Tasks that waited only on this one can start now.
  if (isOpen(cur.status)) await queueUnblocked(s, cur);
  return { ref: cur.ref, title: cur.title };
}

export async function restoreTask(s: Scope, key: string | number, actor: Actor): Promise<Task> {
  const c = await scoped(s);
  const f = taskKeyFilter(key);
  const t = await c.trash.findOne('ref' in f ? { ref: f.ref as number } : { _id: f._id as string }, { sort: { deletedAt: -1 } });
  if (!t) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} is not in the trash`);
  if (await c.tasks.findOne({ ref: t.ref }, { projection: { _id: 1 } })) throw new InputError(`#${t.ref} already exists`);
  // Older trash docs may still carry a claude mark: a restored task is never queued for Claude.
  const { claude: _claude, ...old } = t.task;
  void _claude;
  // Where it lives now: its project may have been made private or shared (or deleted) since it was trashed, and the
  // copy in the trash keeps the placement it had then. Recompute from the project as it is now.
  const org = await orgWide(s.orgId);
  const project = old.projectId ? await org.projects.findOne({ _id: old.projectId }, { projection: { ownerId: 1, visibility: 1 } }) : null;
  const place = placeIn(project, old.ownerId);
  const restored: TaskDoc = { ...old, ...(old.projectId && !project ? { projectId: null } : {}), ...place };
  // Someone who could not see the restored task does not get to put it back.
  if (!canSee(s, restored)) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} is not in the trash`);
  await c.trash.deleteOne({ _id: t._id });
  // Written org-wide: the result may be private to the project's owner (who is then the restorer, see above).
  await org.tasks.insertOne(restored);
  if (t.activity.length) await org.activity.insertMany(t.activity.map(a => ({ ...a, ...place })));
  if (t.noteIds?.length) {
    await org.notes.updateMany({ _id: { $in: t.noteIds } }, { $set: { deletedAt: null }, $unset: { deletedBy: '' } });
    await placeNotes(org, t.noteIds, place);
  }
  await logActivity(org, restored, actor, 'restored');
  return toTask(restored);
}

export type TrashItem = { ref: number; title: string; status: Status; projectId: string | null; deletedAt: string; deletedBy: Actor; reason: string; purgeOn: string };

export async function listTrash(s: Scope): Promise<TrashItem[]> {
  const c = await scoped(s);
  await purgeTrash(s);
  const docs = await c.trash.find({}, { projection: { activity: 0 } }).sort({ deletedAt: -1 }).toArray();
  return docs.map(d => ({
    ref: d.ref,
    title: d.title,
    status: d.task.status,
    projectId: d.task.projectId,
    deletedAt: d.deletedAt.toISOString(),
    deletedBy: asActor(d.deletedBy),
    reason: d.reason,
    purgeOn: new Date(d.deletedAt.getTime() + TRASH_DAYS * 86_400_000).toISOString().slice(0, 10),
  }));
}

/** Permanently remove trash older than 30 days (or one item now, by ref). */
export async function purgeTrash(s: Scope, ref?: number): Promise<number> {
  const c = await scoped(s);
  const r = await c.trash.deleteMany(ref !== undefined ? { ref } : { deletedAt: { $lt: new Date(Date.now() - TRASH_DAYS * 86_400_000) } });
  return r.deletedCount;
}

// ── Comments: edit / delete ─────────────────────────────────────────────────
// An agent may only touch its own entries (same agent, acting for the same person); a person may touch their own and
// their agents' entries. Only comments can be removed (other entries record what changed, so only their note text can
// be edited).

async function ownedEntry(c: Collections, id: string, actor: Actor): Promise<ActivityDoc> {
  const a = await c.activity.findOne({ _id: id });
  if (!a) throw new NotFoundError(`History entry ${id} not found`);
  const by = asActor(a.actor);
  if (actor.kind === 'agent') {
    if (!(by.kind === 'agent' && by.agent === actor.agent && by.userId === actor.userId)) throw new InputError(`${actor.agent === 'claude' ? 'Claude' : 'Claude Code'} can only edit or delete its own history entries.`);
  } else if (isPerson(actor)) {
    if (actorUserId(by) !== actor.userId) throw new InputError('You can only edit or delete your own history entries (and your Claude\u2019s).');
  } else {
    throw new InputError('Only a person or their Claude can edit history entries.');
  }
  return a;
}

export async function editComment(s: Scope, id: string, text: string, actor: Actor): Promise<Activity> {
  const c = await scoped(s);
  const a = await ownedEntry(c, id, actor);
  const note = text.trim();
  if (!note && a.type === 'comment') throw new InputError('Comment text is empty; delete it instead.');
  await c.activity.updateOne({ _id: id }, note ? { $set: { note } } : { $unset: { note: '' } });
  if (note) {
    const t = await c.tasks.findOne({ _id: a.taskId });
    if (t) await takeBackOnEdit(s, t, actor);
  }
  return toActivity({ ...a, note: note || undefined });
}

export async function deleteComment(s: Scope, id: string, actor: Actor): Promise<{ taskRef: number }> {
  const c = await scoped(s);
  const a = await ownedEntry(c, id, actor);
  if (a.type !== 'comment') throw new InputError(`That entry is a "${a.type}" record, not a comment; only its note can be edited.`);
  await c.activity.deleteOne({ _id: id });
  return { taskRef: a.taskRef };
}

// ── Checklist ───────────────────────────────────────────────────────────────

/** True when the checklist has an item text it did not have before (ticking or removing adds no new text). */
function newChecklistText(before: ChecklistItem[], after: ChecklistItem[]): boolean {
  const had = new Set(before.map(i => i.text));
  return after.some(i => !had.has(i.text));
}

export type ChecklistOps = {
  add?: string[];
  check?: (string | number)[];
  uncheck?: (string | number)[];
  remove?: (string | number)[];
};

function findItem(items: ChecklistItem[], key: string | number): ChecklistItem | undefined {
  if (typeof key === 'number') return items[key - 1];
  const s = key.trim();
  if (/^\d+$/.test(s)) return items[Number(s) - 1];
  const lower = s.toLowerCase();
  return (
    items.find(i => i.id === s) ??
    items.find(i => i.text.toLowerCase() === lower) ??
    items.find(i => i.text.toLowerCase().includes(lower))
  );
}

export async function updateChecklist(s: Scope, key: string | number, ops: ChecklistOps, actor: Actor): Promise<Task> {
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  const items = cur.checklist.map(i => ({ ...i }));
  const notes: string[] = [];
  const missing: string[] = [];

  for (const k of ops.check ?? []) {
    const it = findItem(items, k);
    if (!it) missing.push(String(k));
    else if (!it.done) {
      it.done = true;
      notes.push(`checked "${it.text}"`);
    }
  }
  for (const k of ops.uncheck ?? []) {
    const it = findItem(items, k);
    if (!it) missing.push(String(k));
    else if (it.done) {
      it.done = false;
      notes.push(`unchecked "${it.text}"`);
    }
  }
  for (const k of ops.remove ?? []) {
    const it = findItem(items, k);
    if (!it) missing.push(String(k));
    else {
      items.splice(items.indexOf(it), 1);
      notes.push(`removed "${it.text}"`);
    }
  }
  for (const text of ops.add ?? []) {
    const t = text.trim();
    if (!t) continue;
    items.push({ id: shortId(), text: t, done: false });
    notes.push(`added "${t}"`);
  }
  if (missing.length) throw new InputError(`Checklist item(s) not found: ${missing.join(', ')}`);
  if (!notes.length) return toTask(cur);

  const now = new Date();
  await c.tasks.updateOne({ _id: cur._id }, { $set: { checklist: items, updatedAt: now } });
  await logActivity(c, cur, actor, 'checklist', { note: notes.join('; ') });
  if (newChecklistText(cur.checklist, items)) await takeBackOnEdit(s, cur, actor);
  return toTask({ ...cur, checklist: items, updatedAt: now });
}

// ── Recurrence ──────────────────────────────────────────────────────────────

function advance(date: string, r: Recurrence): string {
  const n = r.interval || 1;
  switch (r.freq) {
    case 'daily':
      return addDays(date, n);
    case 'weekdays': {
      let d = date;
      for (let i = 0; i < n; i++) {
        d = addDays(d, 1);
        while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
      }
      return d;
    }
    case 'weekly':
      return addDays(date, 7 * n);
    case 'monthly':
      return addMonths(date, n);
  }
}

async function spawnNextOccurrence(c: Collections, s: Scope, done: TaskDoc, actor: Actor): Promise<number> {
  const today = todayStr();
  const r = done.recurrence!;
  let due = advance(done.due ?? today, r);
  while (due <= today) due = advance(due, r);
  const shift = done.due && done.start ? Math.round((Date.parse(done.due) - Date.parse(done.start)) / 86_400_000) : null;
  const next = await insertTask(
    c,
    s,
    {
      title: done.title,
      description: done.description,
      mode: done.mode,
      project: done.projectId,
      priority: done.priority,
      tags: done.tags,
      due,
      start: shift != null ? addDays(due, -shift) : null,
      estimateMins: done.estimateMins,
      checklist: done.checklist.map(i => i.text),
      links: done.links,
      recurrence: r,
    },
    actor,
    // The next one belongs to whoever owned this one (a shared task completed by a teammate stays theirs).
    { note: `Next occurrence of #${done.ref}`, ownerId: done.ownerId },
  );
  await c.tasks.updateOne({ _id: done._id }, { $set: { nextRef: next.ref } });
  return next.ref;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export type DueFilter = 'overdue' | 'today' | 'today_or_overdue' | 'this_week' | 'next_7_days' | 'no_date' | 'has_date';
export type TaskSort = 'priority' | 'due' | 'updated' | 'created' | 'done';

export type TaskFilter = {
  status?: Status[];
  /** true → only Not Started / In Progress / Blocked */
  open?: boolean;
  project?: string; // id or name
  mode?: Mode;
  tag?: string;
  priority?: Priority[];
  due?: DueFilter;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  archived?: 'exclude' | 'include' | 'only';
  doneFrom?: string; // YYYY-MM-DD, inclusive
  doneTo?: string;
  updatedSince?: Date;
  limit?: number;
  sort?: TaskSort;
};

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const STATUS_RANK: Record<Status, number> = { 'In Progress': 0, Blocked: 1, 'Not Started': 2, Done: 3, Dropped: 4 };

export function sortTasks<T extends Pick<Task, 'priority' | 'due' | 'ref' | 'status' | 'updatedAt' | 'createdAt' | 'doneAt'>>(
  tasks: T[],
  sort: TaskSort = 'priority',
): T[] {
  const dueCmp = (a: T, b: T) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0);
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case 'due':
        return dueCmp(a, b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.ref - b.ref;
      case 'updated':
        return b.updatedAt.localeCompare(a.updatedAt);
      case 'created':
        return b.createdAt.localeCompare(a.createdAt);
      case 'done':
        return (b.doneAt ?? '').localeCompare(a.doneAt ?? '');
      default:
        return (
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
          dueCmp(a, b) ||
          a.ref - b.ref
        );
    }
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listTasks(s: Scope, f: TaskFilter = {}): Promise<Task[]> {
  const c = await scoped(s);
  const q: Filter<TaskDoc> = {};
  const and: Filter<TaskDoc>[] = [];
  const today = todayStr();

  if (f.archived === 'only') q.archived = true;
  else if (f.archived !== 'include') q.archived = false;

  if (f.status?.length) q.status = { $in: f.status };
  else if (f.open) q.status = { $in: OPEN_STATUSES };

  if (f.project) {
    const p = await resolveProject(c, s, f.project, { create: false });
    if (!p) return [];
    q.projectId = p._id;
  }
  if (f.mode) q.mode = f.mode;
  if (f.tag) q.tags = f.tag.replace(/^#/, '').toLowerCase();
  if (f.priority?.length) q.priority = { $in: f.priority };

  switch (f.due) {
    case 'overdue':
      and.push({ due: { $ne: null, $lt: today } }, { status: { $in: OPEN_STATUSES } });
      break;
    case 'today':
      q.due = today;
      break;
    case 'today_or_overdue':
      // Past-due only counts while open; a Done task from last week isn't overdue.
      and.push({ $or: [{ due: today }, { due: { $ne: null, $lt: today }, status: { $in: OPEN_STATUSES } }] });
      break;
    case 'this_week': {
      const ws = weekStart(today);
      and.push({ due: { $gte: ws, $lte: addDays(ws, 6) } });
      break;
    }
    case 'next_7_days':
      and.push({ due: { $gte: today, $lte: addDays(today, 7) } });
      break;
    case 'no_date':
      q.due = null;
      break;
    case 'has_date':
      and.push({ due: { $ne: null } });
      break;
  }
  if (f.dueFrom) and.push({ due: { $gte: f.dueFrom } });
  if (f.dueTo) and.push({ due: { $ne: null, $lte: f.dueTo } });
  if (f.doneFrom) and.push({ doneOn: { $gte: f.doneFrom } });
  if (f.doneTo) and.push({ doneOn: { $ne: null, $lte: f.doneTo } });
  if (f.updatedSince) and.push({ updatedAt: { $gte: f.updatedSince } });
  if (f.q?.trim()) {
    const re = new RegExp(escapeRegex(f.q.trim()), 'i');
    and.push({ $or: [{ title: re }, { description: re }, { tags: re }] });
  }
  if (and.length) q.$and = and;

  const docs = await c.tasks.find(q).toArray();
  const sorted = sortTasks(docs.map(toTask), f.sort ?? 'priority');
  return f.limit ? sorted.slice(0, f.limit) : sorted;
}

export async function getTask(s: Scope, key: string | number): Promise<Task | null> {
  const c = await scoped(s);
  const doc = await c.tasks.findOne(taskKeyFilter(key));
  return doc ? toTask(doc) : null;
}

export type TaskDetail = {
  task: Task;
  project: Project | null;
  activity: Activity[];
  dependencies: Task[];
  dependents: Task[];
};

export async function getTaskDetail(s: Scope, key: string | number, opts: { activityLimit?: number } = {}): Promise<TaskDetail | null> {
  const c = await scoped(s);
  const doc = await c.tasks.findOne(taskKeyFilter(key));
  if (!doc) return null;
  const [project, activity, deps, dependents] = await Promise.all([
    doc.projectId ? c.projects.findOne({ _id: doc.projectId }) : null,
    c.activity
      .find({ taskId: doc._id })
      .sort({ at: -1 })
      .limit(opts.activityLimit ?? 100)
      .toArray(),
    doc.dependsOn.length ? c.tasks.find({ _id: { $in: doc.dependsOn } }).toArray() : [],
    c.tasks.find({ dependsOn: doc._id }).toArray(),
  ]);
  return {
    task: toTask(doc),
    project: project ? toProject(project) : null,
    activity: activity.map(toActivity),
    dependencies: deps.map(toTask),
    dependents: dependents.map(toTask),
  };
}

export type ActivityFilter = {
  since?: Date;
  until?: Date;
  /** me = you in the app; discord, claude, claude-code (any person's), system. */
  actor?: ActorFilter;
  taskId?: string;
  project?: string;
  types?: ActivityType[];
  limit?: number;
};

/** Mongo filter for "who did it". */
export function actorQuery(s: Scope, a: ActorFilter): Filter<ActivityDoc> {
  switch (a) {
    case 'me':
      return { 'actor.kind': 'user', 'actor.userId': s.userId } as Filter<ActivityDoc>;
    case 'claude':
    case 'claude-code':
      return { 'actor.kind': 'agent', 'actor.agent': a } as Filter<ActivityDoc>;
    default:
      return { 'actor.kind': a } as Filter<ActivityDoc>;
  }
}

export async function listActivity(s: Scope, f: ActivityFilter = {}): Promise<Activity[]> {
  const c = await scoped(s);
  const q: Filter<ActivityDoc> = {};
  if (f.since || f.until) q.at = { ...(f.since ? { $gte: f.since } : {}), ...(f.until ? { $lt: f.until } : {}) };
  if (f.actor) Object.assign(q, actorQuery(s, f.actor));
  if (f.types?.length) q.type = { $in: f.types };
  if (f.taskId) q.taskId = f.taskId;
  else if (f.project) {
    const p = await resolveProject(c, s, f.project, { create: false });
    if (!p) return [];
    const ids = await c.tasks.distinct('_id', { projectId: p._id });
    q.taskId = { $in: ids };
  }
  const docs = await c.activity
    .find(q)
    .sort({ at: -1 })
    .limit(f.limit ?? 200)
    .toArray();
  return docs.map(toActivity);
}

/** Open tasks whose dependencies are not all closed. */
export async function unmetDependencies(s: Scope, tasks: Task[]): Promise<Map<string, Task[]>> {
  const depIds = [...new Set(tasks.flatMap(t => t.dependsOn))];
  const out = new Map<string, Task[]>();
  if (!depIds.length) return out;
  const c = await scoped(s);
  const deps = new Map((await c.tasks.find({ _id: { $in: depIds } }).toArray()).map(d => [d._id, toTask(d)]));
  for (const t of tasks) {
    const open = t.dependsOn.map(id => deps.get(id)).filter((d): d is Task => !!d && isOpen(d.status));
    if (open.length) out.set(t.id, open);
  }
  return out;
}
