import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { requestContext } from '../request-context';
import { inTransaction, nextSeq, toActivity, type ActivityDoc, type ClaudeMark, type ProjectDoc, type TaskDoc, type TrashDoc } from '../db';
import { canSee, forUser, orgWide, readableFilter, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import { asActor, isPerson, actorUserId, type ActorFilter, type TextAuthor } from '../actors';
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  TaskInputSchema,
  TaskPatchSchema,
  LINK_SCHEME,
  linkSchemeAllowed,
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
import { placeIn, placeNotes, placeOf, placeTasks, resolveProject, samePlace, toProject, type Placement } from './projects';
import { InputError, NotFoundError } from './errors';
import { MAX_ASSIGNEES, assignedTo, assigneesOf, canBeAssigned, unassigned } from '../assignees';
import { canonicalMode } from '../org-modes';
import { queueUnblocked } from '../alerts';
import { onTaskChanged, takeBackOnEdit } from './dispatcher';

// ── Conversions & helpers ───────────────────────────────────────────────────

export function toTask(d: TaskDoc): Task {
  return {
    id: d._id,
    ref: d.ref,
    title: d.title,
    description: d.description ?? '',
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
    links: d.links ?? [],
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
    ...(d.titleBy ? { titleBy: d.titleBy } : {}),
    ...(d.descriptionBy ? { descriptionBy: d.descriptionBy } : {}),
    ...(d.blockedReasonBy ? { blockedReasonBy: d.blockedReasonBy } : {}),
    ...(d.tagsBy ? { tagsBy: d.tagsBy } : {}),
    ...(d.claude ? { claude: toTaskClaude(d.claude) } : {}),
    parentId: d.parentId ?? null,
    ...(d.parentId ? { parentRef: d.parentRef, parentTitle: d.parentTitle } : {}),
    ...(d.subtaskCount ? { subtaskCount: d.subtaskCount } : {}),
    ownerId: d.ownerId,
    visibility: d.visibility,
    ...(d.visibility === 'members' ? { sharedWith: placeOf(d).sharedWith } : {}),
    assigneeIds: assigneesOf(d),
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
 * Who gets a task's alerts and notices (docs/multi-user.md "Inbox, push, alerts"): its assignees who can see the task
 * (canBeAssigned), else its owner.
 */
export function recipientsOf(t: Pick<TaskDoc, 'ownerId' | 'visibility' | 'sharedWith' | 'assigneeIds' | 'assigneeId'>): string[] {
  const a = assigneesOf(t).filter(u => canBeAssigned(t, u));
  return a.length ? a : [t.ownerId];
}

/** The query form of recipientsOf: tasks whose alerts go to this person. */
export function recipientFilter(userId: string): Filter<TaskDoc> {
  // An assignee who could not see the task (never left so by the writes, but kept safe) leaves its alerts to the owner
  // when none of its assignees can.
  const list = { $cond: [{ $isArray: '$assigneeIds' }, '$assigneeIds', { $cond: [{ $eq: [{ $type: '$assigneeId' }, 'string'] }, ['$assigneeId'], []] }] };
  const cannotSee = [{ visibility: 'private' }, { visibility: 'members', $expr: { $eq: [{ $size: { $setIntersection: [list, { $ifNull: ['$sharedWith', []] }] } }, 0] } }];
  return { $or: [{ $and: [assignedTo(userId), readableFilter(userId)] }, { ownerId: userId, $or: [unassigned(), ...cannotSee] }] } as Filter<TaskDoc>;
}

// ── Assignees (docs/multi-user.md phase 4) ─────────────────────────────────
// Every assignee must be able to see the task (canBeAssigned in lib/assignees.ts, the one rule): any member on a task
// shared with everyone, the people on the list of a project shared with chosen people, only the owner on a private
// task. A task can have several. Anyone else is refused, and a task moved to where an assignee cannot see it loses them.

/**
 * assignees input -> members' user ids (each once, in the order given); 'me' is the caller; null or [] (or only ''
 * / 'none') clears. undefined = not given. `assignee` (one name) is the same as a list of one.
 */
async function resolveAssignees(s: Scope, data: { assignees?: string[] | null; assignee?: string | null }): Promise<string[] | undefined> {
  const raw = data.assignees !== undefined ? (data.assignees ?? []) : data.assignee !== undefined ? (data.assignee === null ? [] : [data.assignee]) : undefined;
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    const t = (v ?? '').trim();
    if (!t || t.toLowerCase() === 'none') continue;
    const id = t.toLowerCase() === 'me' ? s.userId : await findAssignee(s.orgId, t);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_ASSIGNEES) throw new InputError(`A task can have at most ${MAX_ASSIGNEES} assignees`);
  return out;
}

/**
 * One assignee named in an MCP call or the app: a member's user id or email (findMember), else their name: the display
 * name exactly (any case), else a unique first name. Several matches are refused with their names (use the email).
 */
export async function findAssignee(orgId: string, v: string): Promise<string> {
  const { findMember, forgetMembers, memberNames } = await import('../people');
  const id = await findMember(orgId, v);
  if (id) return id;
  const want = v.trim().toLowerCase().replace(/\s+/g, ' ');
  const named = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = async () => {
    const people = Object.entries(await memberNames(orgId));
    const exact = people.filter(([, n]) => named(n) === want);
    return exact.length ? exact : want.includes(' ') ? [] : people.filter(([, n]) => named(n).split(' ')[0] === want);
  };
  let pool = await match();
  // No one by that name in the cached list: someone may have joined in the last minute (as findMember does for emails).
  if (!pool.length) {
    forgetMembers(orgId);
    pool = await match();
  }
  if (pool.length === 1) return pool[0][0];
  if (pool.length > 1) throw new InputError(`assignee: "${v.trim()}" matches more than one member (${pool.map(([, n]) => n).join(', ')}); use their email`);
  throw new InputError(`assignee: "${v.trim()}" is not a member of this organization`);
}

function assertAssignable(place: Placement, assigneeIds: string[], ref?: number): void {
  if (assigneeIds.every(id => canBeAssigned(place, id))) return;
  const what = ref ? `#${ref}` : 'This task';
  if (place.visibility === 'private') throw new InputError(`${what} is private (only its owner sees it), so it can't be assigned to anyone else. Move it to a shared project first.`);
  throw new InputError(`${what} is in a project shared with chosen people, and someone you named is not one of them. The project's owner can add them first.`);
}

/** The assignees kept when a task moves to a placement: only those who can see it there. */
export const keptAssignees = (assigneeIds: string[], place: Placement): string[] => assigneeIds.filter(id => canBeAssigned(place, id));

/** Names for the history line ("Bea, Cy"), or null for nobody. */
async function peopleNames(s: Scope, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const { memberNames } = await import('../people');
  const names = await memberNames(s.orgId);
  return ids.map(id => names[id] ?? 'a former member').join(', ');
}

/**
 * Tells the new assignee (inbox, plus push and Discord by their settings) through the alert queue: written with the
 * task (in its transaction, if any) and sent right after the write (lib/alerts.ts flushQueuedAlerts). Assigning
 * yourself sends nothing.
 */
async function queueAssigned(s: Scope, t: Pick<TaskDoc, '_id'>, assigneeId: string, actor: Actor): Promise<void> {
  if (actorUserId(actor) === assigneeId) return;
  const { whoDid } = await import('./dispatcher');
  const c = await scoped(forUser(s, assigneeId));
  const now = new Date();
  await c.alertQueue.insertOne({ _id: `assigned:${t._id}:${assigneeId}:${now.getTime()}`, orgId: s.orgId, userId: assigneeId, kind: 'assigned', taskId: t._id, byTaskId: t._id, createdAt: now, sentAt: null, detail: (await whoDid(s, actor)).slice(0, 120) });
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

// Each item and link keeps who wrote it (lib/data/authors.ts): one already there keeps its author, a new one is `by`'s.
function normalizeChecklist(
  items: (string | { text: string; done?: boolean })[] | undefined,
  existing: ChecklistItem[] = [],
  by?: TextAuthor,
): ChecklistItem[] {
  if (!items) return [];
  return items.map(it => {
    const text = typeof it === 'string' ? it.trim() : it.text.trim();
    const prev = existing.find(e => e.text === text);
    const done = typeof it === 'string' ? (prev?.done ?? false) : (it.done ?? prev?.done ?? false);
    const who = prev ? prev.by : by;
    return { id: prev?.id ?? shortId(), text, done, ...(who ? { by: who } : {}) };
  });
}

// Every way in (pages, MCP, REST, Discord, import) stores links through here: http(s) and mailto only.
function normalizeUrl(u: string): string {
  const s = u.trim();
  if (!linkSchemeAllowed(s)) throw new InputError(`Link "${s.slice(0, 80)}" is not a web address: only http, https and mailto links are kept.`);
  if (LINK_SCHEME.test(s)) return s;
  return 'https://' + s;
}

function normalizeLinks(links: (string | { url: string; label?: string })[] | undefined, existing: Link[] = [], by?: TextAuthor): Link[] {
  if (!links) return [];
  return links.map(l => {
    const link = typeof l === 'string' ? { url: normalizeUrl(l), label: '' } : { url: normalizeUrl(l.url), label: l.label?.trim() ?? '' };
    const prev = existing.find(e => e.url === link.url && e.label === link.label);
    const who = prev ? prev.by : by;
    return { ...link, ...(who ? { by: who } : {}) };
  });
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
  task: Pick<TaskDoc, '_id' | 'ref' | 'title' | 'orgId' | 'ownerId' | 'visibility' | 'sharedWith'>,
  actor: Actor,
  type: ActivityType,
  extra: { changes?: Record<string, FieldChange>; note?: string; at?: Date } = {},
): Promise<ActivityDoc> {
  // History entries are seen by whoever sees the task.
  const doc: ActivityDoc = {
    _id: randomUUID(),
    orgId: task.orgId,
    ...placeOf(task),
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

// ── Subtasks (docs/subtasks.md) ─────────────────────────────────────────────
// A subtask is a real task with parentId, one level deep (a subtask has no subtasks). It lives where its parent lives:
// the same project, so the same visibility and list; moving the parent moves it. The parent's progress is the average
// of its subtasks' (Done counts 100, Dropped is left out), recomputed whenever one changes (rollUp).

/** Where a subtask of `parent` lives: placeIn the parent's project; with no project, private to the parent's owner. */
function placeUnder(project: Parameters<typeof placeIn>[0], parent: Pick<TaskDoc, 'ownerId'>, owner: string): Placement {
  return project ? placeIn(project, owner) : placeIn(null, parent.ownerId);
}

/** The task a new or moved task goes under: it must exist, not be the task itself, and not be a subtask. */
async function parentFor(c: Collections, key: string | number, selfId?: string): Promise<TaskDoc> {
  const p = await c.tasks.findOne(taskKeyFilter(key));
  if (!p) throw new InputError(`Parent task ${typeof key === 'number' ? '#' + key : key} not found`);
  if (p._id === selfId) throw new InputError(`#${p.ref} can't be a subtask of itself`);
  if (p.parentId) throw new InputError(`#${p.ref} is itself a subtask of #${p.parentRef}: subtasks go one level deep. Put it under #${p.parentRef} instead.`);
  return p;
}

/** The parent's project, checking that a project asked for alongside is that one. */
async function parentProject(c: Collections, s: Scope, parent: TaskDoc, wanted: string | null | undefined, ref?: number) {
  const p = parent.projectId ? await c.projects.findOne({ _id: parent.projectId }) : null;
  if (wanted !== undefined) {
    const w = wanted ? await resolveProject(c, s, wanted, { create: false }) : null;
    if ((w?._id ?? null) !== parent.projectId) {
      throw new InputError(`${ref ? `#${ref}` : 'A subtask'} stays in its parent's project (#${parent.ref} is in ${p ? `"${p.name}"` : 'no project'}). Move #${parent.ref} instead, or take it out from under #${parent.ref} first.`);
    }
  }
  return p;
}

/** Recomputes a parent's subtask count and (while it is open) its progress from its subtasks. */
async function rollUp(c: Collections, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  const parent = await c.tasks.findOne({ _id: parentId }, { projection: { orgId: 1, status: 1, progress: 1, subtaskCount: 1 } });
  if (!parent) return;
  // Every subtask counts, whoever's change this is: the caller sees the parent (found above), and only its count and
  // progress are written, so nothing of a subtask they can't see reaches them but its share of the number.
  const org = await orgWide(parent.orgId);
  const kids = await org.tasks.find({ parentId }, { projection: { status: 1, progress: 1 } }).toArray();
  if (!kids.length) {
    if (parent.subtaskCount) await c.tasks.updateOne({ _id: parentId }, { $unset: { subtaskCount: '' } });
    return;
  }
  const counted = kids.filter(k => k.status !== 'Dropped');
  const subtaskCount = { done: counted.filter(k => k.status === 'Done').length, total: counted.length };
  const set: Partial<TaskDoc> = { subtaskCount };
  if (isOpen(parent.status) && counted.length) set.progress = Math.round(counted.reduce((n, k) => n + (k.status === 'Done' ? 100 : k.progress), 0) / counted.length);
  if (same(parent.subtaskCount, subtaskCount) && (set.progress === undefined || set.progress === parent.progress)) return;
  await c.tasks.updateOne({ _id: parentId }, { $set: set });
}

/** A parent's subtasks, open ones first by number. */
export async function listSubtasks(s: Scope, taskId: string, opts: { open?: boolean } = {}): Promise<Task[]> {
  const c = await scoped(s);
  const docs = await c.tasks.find({ parentId: taskId, ...(opts.open ? { status: { $in: OPEN_STATUSES } } : {}) }).sort({ ref: 1 }).toArray();
  return docs.map(toTask).sort((a, b) => Number(!isOpen(a.status)) - Number(!isOpen(b.status)) || a.ref - b.ref);
}

/**
 * Before a parent moves: each subtask that would be placed differently must be one the caller may move on its own (the
 * same rules as a task's own move, with the subtask's owner), and it never changes owner because its parent moved. Any
 * refusal stops the whole move. Read org-wide so a subtask the caller can't see also holds the move.
 */
async function assertSubtasksMovable(s: Scope, parent: TaskDoc, project: ProjectDoc | null, parentPlace: Placement, oldProjectOwner: string | undefined): Promise<void> {
  const org = await orgWide(parent.orgId);
  const kids = await org.tasks.find({ parentId: parent._id }).toArray();
  for (const k of kids) {
    const place = placeUnder(project, parentPlace, k.ownerId);
    if (samePlace(place, placeOf(k)) || k.ownerId === s.userId) continue;
    const whose = `#${k.ref} under #${parent.ref} is ${(await peopleNames(s, [k.ownerId])) ?? 'someone else'}'s`;
    if (k.visibility === 'private') throw new InputError(`${whose}: only they can move it. Nothing was moved.`);
    if (place.ownerId !== k.ownerId) throw new InputError(`${whose}, and it would no longer be theirs there. Take it out from under #${parent.ref} first, or ask them. Nothing was moved.`);
    if (k.visibility === 'org' && place.visibility !== 'org') throw new InputError(`${whose}: only they can take it out of a project shared with everyone. Nothing was moved.`);
    if (k.visibility === 'members' && s.userId !== oldProjectOwner) throw new InputError(`${whose}: only they or the project's owner can move it out of a project shared with chosen people. Nothing was moved.`);
  }
}

/** Moves a parent's subtasks to where the parent now is (its project and placement); a moved assignee who can't see it there is dropped. */
async function moveSubtasks(c: Collections, s: Scope, parent: TaskDoc, project: ProjectDoc | null, actor: Actor): Promise<void> {
  const kids = await c.tasks.find({ parentId: parent._id }).toArray();
  for (const k of kids) {
    const place = placeUnder(project, parent, k.ownerId);
    const set: Partial<TaskDoc> = {};
    const changes: Record<string, FieldChange> = {};
    if (k.projectId !== parent.projectId) {
      set.projectId = parent.projectId;
      changes.project = { from: k.projectId ? ((await c.projects.findOne({ _id: k.projectId }, { projection: { name: 1 } }))?.name ?? k.projectId) : null, to: project?.name ?? null };
    }
    const before = assigneesOf(k);
    const assigneeIds = keptAssignees(before, place);
    if (assigneeIds.length !== before.length || k.assigneeId !== undefined) set.assigneeIds = assigneeIds;
    if (assigneeIds.length !== before.length) changes.assignee = { from: await peopleNames(s, before), to: await peopleNames(s, assigneeIds) };
    if (Object.keys(set).length) await c.tasks.updateOne({ _id: k._id }, k.assigneeId !== undefined ? { $set: set, $unset: { assigneeId: '' } } : { $set: set });
    if (!samePlace(place, placeOf(k))) await placeTasks(c, [k._id], place);
    if (Object.keys(changes).length) await logActivity(c, { ...k, ...place }, actor, 'edit', { changes, note: `Moved with #${parent.ref}` });
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createTask(
  s: Scope,
  input: TaskInput,
  actor: Actor,
  opts: { note?: string; source?: TaskSource; authors?: TextAuthors } = {},
): Promise<Task> {
  const data = TaskInputSchema.parse(input);
  const c = await scoped(s);
  return toTask(await insertTask(c, s, data, actor, { note: opts.note, source: opts.source, authors: opts.authors }));
}

/**
 * Who wrote a new task's text when it is not the actor that creates it: a Discord message's author, or the original's
 * authors for a recurring task's next copy (lib/data/authors.ts). Anything not given is the actor's.
 */
export type TextAuthors = { title?: TextAuthor; description?: TextAuthor; blockedReason?: TextAuthor; tags?: TextAuthor; checklist?: (TextAuthor | undefined)[]; links?: (TextAuthor | undefined)[] };

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
  opts: { note?: string; source?: TaskSource; ownerId?: string; authors?: TextAuthors } = {},
): Promise<TaskDoc> {
  const au = opts.authors ?? {};
  const now = new Date();
  const today = todayStr();
  const mode = (await canonicalMode(s, data.mode)) ?? null;
  // A subtask goes in its parent's project (docs/subtasks.md).
  const parent = data.parent != null ? await parentFor(c, data.parent) : null;
  const project = parent ? await parentProject(c, s, parent, data.project) : data.project ? await resolveProject(c, s, data.project, { create: true }) : null;
  const status: Status = data.status ?? (data.blockedReason?.trim() ? 'Blocked' : 'Not Started');
  const done = status === 'Done';
  const id = randomUUID();
  const place = parent ? placeUnder(project, parent, opts.ownerId ?? s.userId) : placeIn(project, opts.ownerId ?? s.userId);
  const assigneeIds = (await resolveAssignees(s, data)) ?? [];
  assertAssignable(place, assigneeIds);
  const doc: TaskDoc = {
    _id: id,
    orgId: s.orgId,
    ...place,
    assigneeIds,
    ref: await nextSeq(c.counters, taskCounter(s)),
    title: data.title,
    description: data.description ?? '',
    mode,
    projectId: project?._id ?? null,
    priority: data.priority ?? 'P2',
    status,
    tags: normalizeTags(data.tags),
    due: dateField(data.due, 'due'),
    start: dateField(data.start, 'start'),
    estimateMins: data.estimateMins ?? null,
    progress: done ? 100 : (data.progress ?? 0),
    checklist: normalizeChecklist(data.checklist).map((i, n) => ({ ...i, by: au.checklist?.[n] ?? actor })),
    links: normalizeLinks(data.links).map((l, n) => ({ ...l, by: au.links?.[n] ?? actor })),
    blockedReason: data.blockedReason?.trim() ?? '',
    titleBy: au.title ?? actor,
    ...(data.description?.trim() ? { descriptionBy: au.description ?? actor } : {}),
    ...(data.blockedReason?.trim() ? { blockedReasonBy: au.blockedReason ?? actor } : {}),
    ...(data.tags?.length ? { tagsBy: au.tags ?? actor } : {}),
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
    ...(parent ? { parentId: parent._id, parentRef: parent.ref, parentTitle: parent.title } : {}),
  };
  await c.tasks.insertOne(doc);
  await logActivity(c, doc, actor, 'created', { note: opts.note });
  for (const a of assigneeIds) await queueAssigned(s, doc, a, actor);
  if (parent) await rollUp(c, parent._id);
  return doc;
}

/** A parent and its subtasks in one atomic write (MCP add_task subtasks). */
export async function createTaskWithSubtasks(s: Scope, input: TaskInput, subtasks: TaskInput[], actor: Actor, opts: { note?: string } = {}): Promise<{ task: Task; subtasks: Task[] }> {
  if (subtasks.length && input.parent != null) throw new InputError('A subtask cannot have subtasks of its own: give either parent or subtasks');
  return inTransaction(async () => {
    const task = await createTask(s, input, actor, { note: opts.note });
    const kids: Task[] = [];
    for (const k of subtasks) kids.push(await createTask(s, { ...k, parent: task.id }, actor, { note: opts.note }));
    return { task: kids.length ? ((await getTask(s, task.id)) ?? task) : task, subtasks: kids };
  });
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
  // The organization's spelling; a task keeps a mode that was later removed from the list until someone changes it.
  if (data.mode !== undefined) apply('mode', data.mode === cur.mode ? cur.mode : ((await canonicalMode(s, data.mode)) ?? null));
  if (data.priority !== undefined) apply('priority', data.priority);
  if (data.tags !== undefined) apply('tags', normalizeTags(data.tags));
  if (data.due !== undefined) apply('due', dateField(data.due, 'due'));
  if (data.start !== undefined) apply('start', dateField(data.start, 'start'));
  if (data.estimateMins !== undefined) apply('estimateMins', data.estimateMins ?? null);
  if (data.checklist !== undefined) apply('checklist', normalizeChecklist(data.checklist, cur.checklist, actor));
  if (data.links !== undefined) apply('links', normalizeLinks(data.links, cur.links ?? [], actor));
  if (data.dependsOn !== undefined) apply('dependsOn', await resolveDependencies(c, data.dependsOn, cur._id));
  if (data.recurrence !== undefined) apply('recurrence', data.recurrence ?? null);

  // Subtasks (docs/subtasks.md): `parent` puts the task under another (it joins that task's project) or, null, takes it
  // out. A subtask can't change project on its own: it moves with its parent.
  let parentSet: TaskDoc | null | undefined;
  if (data.parent !== undefined) {
    const p = data.parent === null ? null : await parentFor(c, data.parent, cur._id);
    if ((p?._id ?? null) !== (cur.parentId ?? null)) {
      if (p && (await c.tasks.findOne({ parentId: cur._id }, { projection: { _id: 1 } }))) {
        throw new InputError(`#${cur.ref} has subtasks of its own, so it can't go under #${p.ref}: subtasks go one level deep`);
      }
      parentSet = p;
      changes.parent = { from: cur.parentId ? `#${cur.parentRef} ${cur.parentTitle ?? ''}`.trim() : null, to: p ? `#${p.ref} ${p.title}` : null };
    }
  }
  const parentNow = parentSet !== undefined ? parentSet : cur.parentId && data.project !== undefined ? await c.tasks.findOne({ _id: cur.parentId }) : null;
  let target: ProjectDoc | null | undefined;
  if (parentNow) {
    const p = await parentProject(c, s, parentNow, data.project, cur.ref);
    if (parentSet) target = p;
  } else if (data.project !== undefined) {
    // (Taken out from under its parent, a task stays in the project it is in unless one is given.)
    target = data.project ? await resolveProject(c, s, data.project, { create: true }) : null;
  }

  let moveTo: Placement | null = null;
  if (target !== undefined) {
    const p = target;
    const old = cur.projectId ? await c.projects.findOne({ _id: cur.projectId }, { projection: { name: 1, ownerId: 1 } }) : null;
    if ((p?._id ?? null) !== cur.projectId) {
      set.projectId = p?._id ?? null;
      changes.project = { from: old?.name ?? cur.projectId, to: p?.name ?? null };
    }
    // The task follows its project. Taking a shared task to fewer people (a private project, or one shared with chosen
    // people) is its owner's call.
    const place = parentNow ? placeUnder(p, parentNow, cur.ownerId) : placeIn(p, cur.ownerId);
    if (!samePlace(place, placeOf(cur))) {
      if (cur.visibility !== 'private' && place.visibility !== 'org' && cur.ownerId !== s.userId) {
        throw new InputError(`Only the task's owner can take #${cur.ref} out of a project shared with everyone`);
      }
      // Out of a project shared with chosen people, it may reach people the list kept out: the task's owner or the
      // project's owner decides that, not anyone else on the list.
      if (cur.visibility === 'members' && s.userId !== cur.ownerId && s.userId !== old?.ownerId) {
        throw new InputError(`Only the task's owner or the project's owner can move #${cur.ref} out of a project shared with chosen people`);
      }
      moveTo = place;
    }
    // A parent's subtasks go with it: each must be one the caller may move too.
    if (!parentNow && ((p?._id ?? null) !== cur.projectId || moveTo)) await assertSubtasksMovable(s, cur, p, moveTo ?? placeOf(cur), old?.ownerId);
  }

  // Assignees: people who can see the task where it ends up. A move drops those who could not.
  const place: Placement = moveTo ?? placeOf(cur);
  const wanted = await resolveAssignees(s, data);
  if (wanted !== undefined) assertAssignable(place, wanted, cur.ref);
  const before = assigneesOf(cur);
  const assigneeIds = wanted !== undefined ? wanted : keptAssignees(before, place);
  const added = assigneeIds.filter(id => !before.includes(id));
  if (added.length || before.some(id => !assigneeIds.includes(id))) {
    set.assigneeIds = assigneeIds;
    changes.assignee = { from: await peopleNames(s, before), to: await peopleNames(s, assigneeIds) };
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
  // Who wrote the text that changed (lib/data/authors.ts); items and links carry their own (normalizeChecklist).
  if (changes.title) set.titleBy = actor;
  if (changes.description) set.descriptionBy = actor;
  if (changes.blockedReason) set.blockedReasonBy = actor;
  if (changes.tags) set.tagsBy = actor;

  const hasChanges = Object.keys(changes).length > 0;
  // Someone else changing what Claude reads takes the task back from Claude (docs/dispatcher.md). It happens before the
  // write: a claim needs the mark still queued, so no session can start on the edited text.
  const readsChanged = !!(changes.title || changes.description || (set.checklist && newChecklistText(cur.checklist, set.checklist)) || opts.note?.trim());
  const tookBack = readsChanged ? await takeBackOnEdit(s, cur, actor) : false;
  if (!hasChanges) {
    if (opts.note?.trim()) {
      await logActivity(c, cur, actor, opts.kind === 'progress' ? 'progress' : 'comment', { note: opts.note });
      await c.tasks.updateOne({ _id: cur._id }, { $set: { updatedAt: now } });
      return toTask({ ...cur, updatedAt: now });
    }
    return toTask(cur);
  }

  set.updatedAt = now;
  if (parentSet) Object.assign(set, { parentId: parentSet._id, parentRef: parentSet.ref, parentTitle: parentSet.title });
  // A task from before several assignees moves over to the list with its next change.
  const legacy = cur.assigneeId !== undefined;
  if (legacy) set.assigneeIds = assigneeIds;
  const unset: Record<string, ''> = { ...(legacy ? { assigneeId: '' as const } : {}), ...(parentSet === null ? { parentId: '' as const, parentRef: '' as const, parentTitle: '' as const } : {}) };
  await c.tasks.updateOne({ _id: cur._id }, Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set });
  if (moveTo) await placeTasks(c, [cur._id], moveTo);
  const next: TaskDoc = { ...cur, ...set, ...(moveTo ?? {}) };
  delete next.assigneeId;
  if (parentSet === null) {
    delete next.parentId;
    delete next.parentRef;
    delete next.parentTitle;
  }
  // A parent: its subtasks follow it to another project and keep its title; reopening it takes its progress from them.
  if (!next.parentId) {
    if (set.projectId !== undefined || moveTo) await moveSubtasks(c, s, next, target ?? null, actor);
    if (changes.title) await c.tasks.updateMany({ parentId: cur._id }, { $set: { parentTitle: next.title } });
  }
  // A subtask: its old and new parent's rollup.
  if (changes.status || changes.progress || parentSet !== undefined) {
    await rollUp(c, cur.parentId);
    if (parentSet) await rollUp(c, parentSet._id);
  }
  if (changes.status && cur.subtaskCount) {
    await rollUp(c, cur._id);
    next.progress = (await c.tasks.findOne({ _id: cur._id }, { projection: { progress: 1 } }))?.progress ?? next.progress;
  }

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
  for (const a of added) await queueAssigned(s, next, a, actor);
  if (tookBack) next.claude = (await c.tasks.findOne({ _id: cur._id }, { projection: { claude: 1 } }))?.claude ?? next.claude;
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

/**
 * Marks a task Done. A parent's open subtasks stay open unless closeSubtasks (the app asks "Close the N open subtasks
 * too?"; MCP leaves them open and lists them).
 */
export async function completeTask(s: Scope, key: string | number, note: string | undefined, actor: Actor, opts: { closeSubtasks?: boolean } = {}): Promise<Task> {
  if (opts.closeSubtasks) {
    const t = await getTask(s, key);
    if (t) for (const k of await listSubtasks(s, t.id, { open: true })) await updateTask(s, k.id, { status: 'Done' }, actor, { note: `Closed with #${t.ref}` });
  }
  return updateTask(s, key, { status: 'Done' }, actor, { note });
}

export async function addComment(s: Scope, key: string | number, note: string, actor: Actor): Promise<Task> {
  if (!note.trim()) throw new InputError('Note is empty');
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  const now = new Date();
  await takeBackOnEdit(s, cur, actor);
  await c.tasks.updateOne({ _id: cur._id }, { $set: { updatedAt: now } });
  await logActivity(c, cur, actor, 'comment', { note });
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
): Promise<{ ref: number; title: string; subtasks?: number }> {
  const c = await scoped(s);
  const cur = await findTaskDoc(c, key);
  if (opts.expectTitle !== undefined && !titleMatches(cur.title, opts.expectTitle)) {
    throw new InputError(`#${cur.ref} is "${cur.title}", not "${opts.expectTitle}". Nothing deleted.`);
  }
  const at = new Date();
  // A parent takes its subtasks with it; restoring it brings them back (docs/subtasks.md).
  const kids = await c.tasks.find({ parentId: cur._id }).toArray();
  for (const k of kids) await trashOne(c, s, k, actor, at, opts.reason, cur._id);
  await trashOne(c, s, cur, actor, at, opts.reason);
  await rollUp(c, cur.parentId);
  return { ref: cur.ref, title: cur.title, ...(kids.length ? { subtasks: kids.length } : {}) };
}

async function trashOne(c: Collections, s: Scope, cur: TaskDoc, actor: Actor, at: Date, reason?: string, withParent?: string): Promise<void> {
  const activity = await c.activity.find({ taskId: cur._id }).toArray();
  const notes = await c.notes.find({ taskId: cur._id, deletedAt: null }, { projection: { _id: 1 } }).toArray();
  // A restored task must not come back queued for Claude: the person marks it again if they want.
  const { claude: _claude, ...plain } = cur;
  void _claude;
  const doc: TrashDoc = {
    _id: cur._id,
    orgId: cur.orgId,
    ...placeOf(cur),
    ref: cur.ref,
    title: cur.title,
    task: plain,
    activity,
    deletedAt: at,
    deletedBy: actor,
    reason: reason?.trim() ?? '',
    ...(notes.length ? { noteIds: notes.map(n => n._id) } : {}),
    ...(withParent ? { withParent } : {}),
  };
  if (notes.length) await c.notes.updateMany({ _id: { $in: notes.map(n => n._id) } }, { $set: { deletedAt: doc.deletedAt, deletedBy: actor } });
  await c.trash.replaceOne({ _id: cur._id }, doc, { upsert: true });
  await c.tasks.deleteOne({ _id: cur._id });
  await c.activity.deleteMany({ taskId: cur._id });
  // One line stays in the feed so "who deleted what" shows in History and recent_activity.
  await logActivity(c, cur, actor, 'trashed', { note: withParent ? `With its parent${reason?.trim() ? `: ${reason.trim()}` : ''}` : reason });
  // Tasks that waited only on this one can start now.
  if (isOpen(cur.status)) await queueUnblocked(s, cur);
}

export async function restoreTask(s: Scope, key: string | number, actor: Actor): Promise<Task> {
  const c = await scoped(s);
  const f = taskKeyFilter(key);
  const t = await c.trash.findOne('ref' in f ? { ref: f.ref as number } : { _id: f._id as string }, { sort: { deletedAt: -1 } });
  if (!t) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} is not in the trash`);
  if (t.withParent) {
    const p = await c.trash.findOne({ _id: t.withParent }, { projection: { ref: 1 } });
    if (p) throw new InputError(`#${t.ref} went to the trash with its parent #${p.ref}: restore #${p.ref} and it comes back too`);
  }
  const org = await orgWide(s.orgId);
  const restored = await restoreOne(s, c, org, t, actor, key);
  // Its subtasks that went with it come back with it.
  for (const k of await c.trash.find({ withParent: t._id }).toArray()) await restoreOne(s, c, org, k, actor, k.ref, restored);
  await rollUp(org, restored._id);
  await rollUp(org, restored.parentId);
  const back = await org.tasks.findOne({ _id: restored._id });
  return toTask(back ?? restored);
}

async function restoreOne(s: Scope, c: Collections, org: Collections, t: TrashDoc, actor: Actor, key: string | number, under?: TaskDoc): Promise<TaskDoc> {
  if (await c.tasks.findOne({ ref: t.ref }, { projection: { _id: 1 } })) throw new InputError(`#${t.ref} already exists`);
  // Older trash docs may still carry a claude mark: a restored task is never queued for Claude.
  const { claude: _claude, ...old } = t.task;
  void _claude;
  // A subtask goes back under its parent when the parent is still there (and into its project); else on its own.
  const parent = under ?? (old.parentId ? await org.tasks.findOne({ _id: old.parentId }) : null);
  const projectId = parent ? parent.projectId : old.projectId;
  // Where it lives now: its project may have been made private or shared (or deleted) since it was trashed, and the
  // copy in the trash keeps the placement it had then. Recompute from the project as it is now.
  const project = projectId ? await org.projects.findOne({ _id: projectId }, { projection: { ownerId: 1, visibility: 1, sharedWith: 1 } }) : null;
  const place = parent ? placeUnder(project, parent, old.ownerId) : placeIn(project, old.ownerId);
  const { parentId: _p, parentRef: _r, parentTitle: _t, ...rest } = old;
  void [_p, _r, _t];
  const restored: TaskDoc = {
    ...rest,
    projectId: project ? project._id : null,
    ...place,
    assigneeIds: keptAssignees(assigneesOf(old), place),
    ...(parent ? { parentId: parent._id, parentRef: parent.ref, parentTitle: parent.title } : {}),
  };
  delete restored.assigneeId;
  // Someone who could not see the restored task does not get to put it back.
  if (!canSee(s, restored)) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} is not in the trash`);
  // Written org-wide: the result may be private to the project's owner (who is then the restorer, see above).
  // The task goes back first and the trash entry goes last: a failure part-way leaves the trash entry in place (a retry
  // then says "#12 already exists"), never a task in neither place.
  await org.tasks.insertOne(restored);
  if (t.activity.length) await org.activity.insertMany(t.activity.map(a => ({ ...a, ...place })));
  if (t.noteIds?.length) {
    await org.notes.updateMany({ _id: { $in: t.noteIds } }, { $set: { deletedAt: null }, $unset: { deletedBy: '' } });
    await placeNotes(org, t.noteIds, place);
  }
  await c.trash.deleteOne({ _id: t._id });
  await logActivity(org, restored, actor, 'restored');
  return restored;
}

export type TrashItem = { ref: number; title: string; status: Status; projectId: string | null; deletedAt: string; deletedBy: Actor; reason: string; purgeOn: string };

export async function listTrash(s: Scope): Promise<TrashItem[]> {
  const c = await scoped(s);
  await purgeTrash(s);
  // Subtasks that went with their parent are not listed: they come back (and go for good) with it.
  const docs = await c.trash.find({ withParent: { $exists: false } }, { projection: { activity: 0 } }).sort({ deletedAt: -1 }).toArray();
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
  if (ref !== undefined) {
    const t = await c.trash.findOne({ ref }, { projection: { _id: 1 } });
    if (!t) return 0;
    return (await c.trash.deleteMany({ $or: [{ _id: t._id }, { withParent: t._id }] })).deletedCount;
  }
  const r = await c.trash.deleteMany({ deletedAt: { $lt: new Date(Date.now() - TRASH_DAYS * 86_400_000) } });
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
  if (note) {
    const t = await c.tasks.findOne({ _id: a.taskId });
    if (t) await takeBackOnEdit(s, t, actor);
  }
  await c.activity.updateOne({ _id: id }, note ? { $set: { note } } : { $unset: { note: '' } });
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
    items.push({ id: shortId(), text: t, done: false, by: actor });
    notes.push(`added "${t}"`);
  }
  if (missing.length) throw new InputError(`Checklist item(s) not found: ${missing.join(', ')}`);
  if (!notes.length) return toTask(cur);

  const now = new Date();
  if (newChecklistText(cur.checklist, items)) await takeBackOnEdit(s, cur, actor);
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

async function spawnNextOccurrence(c: Collections, s: Scope, done: TaskDoc, actor: Actor): Promise<number> {
  const today = todayStr();
  const r = done.recurrence!;
  let due = advance(done.due ?? today, r);
  while (due <= today) due = advance(due, r);
  const shift = done.due && done.start ? Math.round((Date.parse(done.due) - Date.parse(done.start)) / 86_400_000) : null;
  // The copy's text is still whoever wrote the original's (an unknown author stays unknown), not the person completing it.
  const { taskAuthors } = await import('./authors');
  const a = await taskAuthors(s, done);
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
      ...(done.parentId && (await c.tasks.findOne({ _id: done.parentId }, { projection: { _id: 1 } })) ? { parent: done.parentId } : {}),
    },
    actor,
    // The next one belongs to whoever owned this one (a shared task completed by a teammate stays theirs).
    {
      note: `Next occurrence of #${done.ref}`,
      ownerId: done.ownerId,
      authors: { title: a.title, description: a.description, tags: a.tags, checklist: a.checklist, links: a.links },
    },
  );
  await c.tasks.updateOne({ _id: done._id }, { $set: { nextRef: next.ref } });
  // Its subtasks come back as new open subtasks of the next one, like the checklist (Dropped ones are left out).
  const kids = await c.tasks.find({ parentId: done._id, status: { $ne: 'Dropped' } }, { projection: { title: 1, ownerId: 1 } }).sort({ ref: 1 }).toArray();
  for (const k of kids) await insertTask(c, s, { title: k.title, parent: next._id }, actor, { note: `Next occurrence of #${done.ref}`, ownerId: k.ownerId });
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
  /** Only tasks this member is one of the assignees of (a user id). */
  assignee?: string;
  /** Only the subtasks of this task (a ref, "#12" or an id). */
  parent?: string | number;
  limit?: number;
  sort?: TaskSort;
  /**
   * For task lists sent to the browser (Today, Tasks): without description, links and source, which no row shows (they
   * come back empty). Today sends every open task the person can see, so they were most of its page (docs/cpu.md).
   */
  forList?: boolean;
};

const LIST_OMIT = { description: 0, links: 0, source: 0 } as const;

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
  if (f.parent !== undefined) {
    const p = await c.tasks.findOne(taskKeyFilter(f.parent), { projection: { _id: 1 } });
    if (!p) throw new NotFoundError(`Task ${f.parent} not found`);
    q.parentId = p._id;
  }
  if (f.mode) q.mode = f.mode;
  if (f.assignee) and.push(assignedTo(f.assignee) as Filter<TaskDoc>);
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

  const docs = await c.tasks.find(q, f.forList ? { projection: LIST_OMIT } : {}).toArray();
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
  /** Subtasks (docs/subtasks.md): the parent of a subtask, the subtasks of a parent (open first). */
  parent: Task | null;
  subtasks: Task[];
};

export async function getTaskDetail(s: Scope, key: string | number, opts: { activityLimit?: number } = {}): Promise<TaskDetail | null> {
  const c = await scoped(s);
  const doc = await c.tasks.findOne(taskKeyFilter(key));
  if (!doc) return null;
  const [project, activity, deps, dependents, parent, subtasks] = await Promise.all([
    doc.projectId ? c.projects.findOne({ _id: doc.projectId }) : null,
    c.activity
      .find({ taskId: doc._id })
      .sort({ at: -1 })
      .limit(opts.activityLimit ?? 100)
      .toArray(),
    doc.dependsOn.length ? c.tasks.find({ _id: { $in: doc.dependsOn } }).toArray() : [],
    c.tasks.find({ dependsOn: doc._id }).toArray(),
    doc.parentId ? c.tasks.findOne({ _id: doc.parentId }) : null,
    doc.parentId ? [] : listSubtasks(s, doc._id),
  ]);
  return {
    task: toTask(doc),
    project: project ? toProject(project) : null,
    activity: activity.map(toActivity),
    dependencies: deps.map(toTask),
    dependents: dependents.map(toTask),
    parent: parent ? toTask(parent) : null,
    subtasks,
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
