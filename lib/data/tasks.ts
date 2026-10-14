import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { requestContext } from '../request-context';
import { collections, nextSeq, toActivity, type ActivityDoc, type Collections, type TaskDoc, type TrashDoc } from '../db';
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
  type TaskInput,
  type TaskPatch,
  type TaskSource,
} from '../types';
import { addDays, addMonths, resolveDate, todayStr, weekday, weekStart } from '../dates';
import { resolveProject, toProject } from './projects';
import { InputError, NotFoundError } from './errors';
import { queueUnblocked } from '../alerts';

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
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    doneAt: d.doneAt ? d.doneAt.toISOString() : null,
    doneOn: d.doneOn,
    doneBy: d.doneBy,
    ...(d.source ? { source: d.source } : {}),
  };
}

export function isOpen(status: Status): boolean {
  return !CLOSED_STATUSES.includes(status);
}

export function isOverdue(t: Pick<Task, 'due' | 'status'>, today: string = todayStr()): boolean {
  return !!t.due && t.due < today && isOpen(t.status);
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
  task: Pick<TaskDoc, '_id' | 'ref' | 'title'>,
  actor: Actor,
  type: ActivityType,
  extra: { changes?: Record<string, FieldChange>; note?: string; at?: Date } = {},
): Promise<ActivityDoc> {
  const doc: ActivityDoc = {
    _id: randomUUID(),
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
  input: TaskInput,
  actor: Actor,
  opts: { note?: string; source?: TaskSource } = {},
): Promise<Task> {
  const data = TaskInputSchema.parse(input);
  const c = await collections();
  return toTask(await insertTask(c, data, actor, opts.note, opts.source));
}

/** The task already created from this external message, if any. */
export async function findTaskBySourceMessage(messageId: string): Promise<Task | null> {
  const c = await collections();
  const d = await c.tasks.findOne({ 'source.messageId': messageId });
  return d ? toTask(d) : null;
}

async function insertTask(
  c: Collections,
  data: ReturnType<typeof TaskInputSchema.parse>,
  actor: Actor,
  note?: string,
  source?: TaskSource,
): Promise<TaskDoc> {
  const now = new Date();
  const today = todayStr();
  const project = data.project ? await resolveProject(c, data.project, { create: true }) : null;
  const status: Status = data.status ?? (data.blockedReason?.trim() ? 'Blocked' : 'Not Started');
  const done = status === 'Done';
  const id = randomUUID();
  const doc: TaskDoc = {
    _id: id,
    ref: await nextSeq(c.counters, 'task'),
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
    ...(source ? { source } : {}),
  };
  await c.tasks.insertOne(doc);
  await logActivity(c, doc, actor, 'created', { note });
  return doc;
}

export async function bulkCreateTasks(inputs: TaskInput[], actor: Actor): Promise<Task[]> {
  const out: Task[] = [];
  for (const i of inputs) out.push(await createTask(i, actor));
  return out;
}

// ── Update ──────────────────────────────────────────────────────────────────

type UpdateOpts = {
  note?: string;
  /** 'progress' logs the change as a progress update rather than an edit. */
  kind?: 'progress';
};

export async function updateTask(key: string | number, patch: TaskPatch, actor: Actor, opts: UpdateOpts = {}): Promise<Task> {
  const data = TaskPatchSchema.parse(patch);
  const c = await collections();
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

  if (data.project !== undefined) {
    const p = data.project ? await resolveProject(c, data.project, { create: true }) : null;
    if ((p?._id ?? null) !== cur.projectId) {
      const old = cur.projectId ? await c.projects.findOne({ _id: cur.projectId }, { projection: { name: 1 } }) : null;
      set.projectId = p?._id ?? null;
      changes.project = { from: old?.name ?? cur.projectId, to: p?.name ?? null };
    }
  }

  // Status and its side effects.
  let status: Status = data.status ?? cur.status;
  const reason = data.blockedReason?.trim();
  if (data.status === undefined && reason && isOpen(cur.status) && cur.status !== 'Blocked') status = 'Blocked';
  if (data.status === undefined && data.progress !== undefined && data.progress > 0 && cur.status === 'Not Started') {
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
      return toTask({ ...cur, updatedAt: now });
    }
    return toTask(cur);
  }

  set.updatedAt = now;
  await c.tasks.updateOne({ _id: cur._id }, { $set: set });
  const next: TaskDoc = { ...cur, ...set };

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

  if (statusChanged && CLOSED_STATUSES.includes(status) && isOpen(cur.status)) await queueUnblocked(c, next);
  if (statusChanged && status === 'Done' && next.recurrence && !next.nextRef) {
    next.nextRef = await spawnNextOccurrence(c, next, actor);
  }
  return toTask(next);
}

async function progressBeforeCompletion(c: Collections, taskId: string): Promise<number> {
  const done = await c.activity.findOne({ taskId, type: 'completed', 'changes.progress.from': { $type: 'number' } }, { sort: { at: -1 } });
  const from = done?.changes?.progress?.from;
  return typeof from === 'number' && from < 100 ? from : 0;
}

export async function logProgress(
  key: string | number,
  progress: number,
  note: string | undefined,
  actor: Actor,
  status?: Status,
  blockedReason?: string,
): Promise<Task> {
  return updateTask(key, { progress, ...(status ? { status } : {}), ...(blockedReason !== undefined ? { blockedReason } : {}) }, actor, { note, kind: 'progress' });
}

export async function completeTask(key: string | number, note: string | undefined, actor: Actor): Promise<Task> {
  return updateTask(key, { status: 'Done' }, actor, { note });
}

export async function addComment(key: string | number, note: string, actor: Actor): Promise<Task> {
  if (!note.trim()) throw new InputError('Note is empty');
  const c = await collections();
  const cur = await findTaskDoc(c, key);
  const now = new Date();
  await c.tasks.updateOne({ _id: cur._id }, { $set: { updatedAt: now } });
  await logActivity(c, cur, actor, 'comment', { note });
  return toTask({ ...cur, updatedAt: now });
}

export async function setArchived(key: string | number, archived: boolean, actor: Actor): Promise<Task> {
  const c = await collections();
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
  key: string | number,
  actor: Actor,
  opts: { reason?: string; expectTitle?: string } = {},
): Promise<{ ref: number; title: string }> {
  const c = await collections();
  const cur = await findTaskDoc(c, key);
  if (opts.expectTitle !== undefined && !titleMatches(cur.title, opts.expectTitle)) {
    throw new InputError(`#${cur.ref} is "${cur.title}", not "${opts.expectTitle}". Nothing deleted.`);
  }
  const activity = await c.activity.find({ taskId: cur._id }).toArray();
  const notes = await c.notes.find({ taskId: cur._id, deletedAt: null }, { projection: { _id: 1 } }).toArray();
  const doc: TrashDoc = {
    _id: cur._id,
    ref: cur.ref,
    title: cur.title,
    task: cur,
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
  if (isOpen(cur.status)) await queueUnblocked(c, cur);
  return { ref: cur.ref, title: cur.title };
}

export async function restoreTask(key: string | number, actor: Actor): Promise<Task> {
  const c = await collections();
  const f = taskKeyFilter(key);
  const t = await c.trash.findOne('ref' in f ? { ref: f.ref as number } : { _id: f._id as string }, { sort: { deletedAt: -1 } });
  if (!t) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} is not in the trash`);
  if (await c.tasks.findOne({ ref: t.ref }, { projection: { _id: 1 } })) throw new InputError(`#${t.ref} already exists`);
  await c.tasks.insertOne(t.task);
  if (t.activity.length) await c.activity.insertMany(t.activity);
  if (t.noteIds?.length) await c.notes.updateMany({ _id: { $in: t.noteIds } }, { $set: { deletedAt: null }, $unset: { deletedBy: '' } });
  await c.trash.deleteOne({ _id: t._id });
  await logActivity(c, t.task, actor, 'restored');
  return toTask(t.task);
}

export type TrashItem = { ref: number; title: string; status: Status; projectId: string | null; deletedAt: string; deletedBy: Actor; reason: string; purgeOn: string };

export async function listTrash(): Promise<TrashItem[]> {
  const c = await collections();
  await purgeTrash();
  const docs = await c.trash.find({}, { projection: { activity: 0 } }).sort({ deletedAt: -1 }).toArray();
  return docs.map(d => ({
    ref: d.ref,
    title: d.title,
    status: d.task.status,
    projectId: d.task.projectId,
    deletedAt: d.deletedAt.toISOString(),
    deletedBy: d.deletedBy,
    reason: d.reason,
    purgeOn: new Date(d.deletedAt.getTime() + TRASH_DAYS * 86_400_000).toISOString().slice(0, 10),
  }));
}

/** Permanently remove trash older than 30 days (or one item now, by ref). */
export async function purgeTrash(ref?: number): Promise<number> {
  const c = await collections();
  const r = await c.trash.deleteMany(ref !== undefined ? { ref } : { deletedAt: { $lt: new Date(Date.now() - TRASH_DAYS * 86_400_000) } });
  return r.deletedCount;
}

// ── Comments: edit / delete ─────────────────────────────────────────────────
// Claude may only touch its own entries; it can remove only comments (other entries
// record what changed, so only their note text can be edited). Om can do either on any.

async function ownedEntry(c: Collections, id: string, actor: Actor): Promise<ActivityDoc> {
  const a = await c.activity.findOne({ _id: id });
  if (!a) throw new NotFoundError(`History entry ${id} not found`);
  if ((actor === 'claude' || actor === 'claude-code') && a.actor !== actor) throw new InputError(`${actor === 'claude' ? 'Claude' : 'Claude Code'} can only edit or delete its own history entries.`);
  return a;
}

export async function editComment(id: string, text: string, actor: Actor): Promise<Activity> {
  const c = await collections();
  const a = await ownedEntry(c, id, actor);
  const note = text.trim();
  if (!note && a.type === 'comment') throw new InputError('Comment text is empty; delete it instead.');
  await c.activity.updateOne({ _id: id }, note ? { $set: { note } } : { $unset: { note: '' } });
  return toActivity({ ...a, note: note || undefined });
}

export async function deleteComment(id: string, actor: Actor): Promise<{ taskRef: number }> {
  const c = await collections();
  const a = await ownedEntry(c, id, actor);
  if (a.type !== 'comment') throw new InputError(`That entry is a "${a.type}" record, not a comment; only its note can be edited.`);
  await c.activity.deleteOne({ _id: id });
  return { taskRef: a.taskRef };
}

// ── Checklist ───────────────────────────────────────────────────────────────

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

export async function updateChecklist(key: string | number, ops: ChecklistOps, actor: Actor): Promise<Task> {
  const c = await collections();
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

async function spawnNextOccurrence(c: Collections, done: TaskDoc, actor: Actor): Promise<number> {
  const today = todayStr();
  const r = done.recurrence!;
  let due = advance(done.due ?? today, r);
  while (due <= today) due = advance(due, r);
  const shift = done.due && done.start ? Math.round((Date.parse(done.due) - Date.parse(done.start)) / 86_400_000) : null;
  const next = await insertTask(
    c,
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
    `Next occurrence of #${done.ref}`,
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

export async function listTasks(f: TaskFilter = {}): Promise<Task[]> {
  const c = await collections();
  const q: Filter<TaskDoc> = {};
  const and: Filter<TaskDoc>[] = [];
  const today = todayStr();

  if (f.archived === 'only') q.archived = true;
  else if (f.archived !== 'include') q.archived = false;

  if (f.status?.length) q.status = { $in: f.status };
  else if (f.open) q.status = { $in: OPEN_STATUSES };

  if (f.project) {
    const p = await resolveProject(c, f.project, { create: false });
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

export async function getTask(key: string | number): Promise<Task | null> {
  const c = await collections();
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

export async function getTaskDetail(key: string | number, opts: { activityLimit?: number } = {}): Promise<TaskDetail | null> {
  const c = await collections();
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
  actor?: Actor;
  taskId?: string;
  project?: string;
  types?: ActivityType[];
  limit?: number;
};

export async function listActivity(f: ActivityFilter = {}): Promise<Activity[]> {
  const c = await collections();
  const q: Filter<ActivityDoc> = {};
  if (f.since || f.until) q.at = { ...(f.since ? { $gte: f.since } : {}), ...(f.until ? { $lt: f.until } : {}) };
  if (f.actor) q.actor = f.actor;
  if (f.types?.length) q.type = { $in: f.types };
  if (f.taskId) q.taskId = f.taskId;
  else if (f.project) {
    const p = await resolveProject(c, f.project, { create: false });
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
export async function unmetDependencies(tasks: Task[]): Promise<Map<string, Task[]>> {
  const depIds = [...new Set(tasks.flatMap(t => t.dependsOn))];
  const out = new Map<string, Task[]>();
  if (!depIds.length) return out;
  const c = await collections();
  const deps = new Map((await c.tasks.find({ _id: { $in: depIds } }).toArray()).map(d => [d._id, toTask(d)]));
  for (const t of tasks) {
    const open = t.dependsOn.map(id => deps.get(id)).filter((d): d is Task => !!d && isOpen(d.status));
    if (open.length) out.set(t.id, open);
  }
  return out;
}
