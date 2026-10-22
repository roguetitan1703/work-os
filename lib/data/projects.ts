import 'server-only';
import { randomBytes } from 'node:crypto';
import type { ProjectDoc, TaskDoc } from '../db';
import { idTaken, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import {
  ProjectInputSchema,
  type Project,
  type ProjectInput,
  type ProjectStats,
  type ProjectWithStats,
  type Visibility,
} from '../types';
import { todayStr, weekStart } from '../dates';
import { InputError, NotFoundError } from './errors';
import { cleanCodeLocations, codeCandidates, matchCodeLocation, type CodeQuery } from './code-locations';
import type { CodeLocation } from '../types';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

export function toProject(d: ProjectDoc): Project {
  return {
    id: d._id,
    name: d.name,
    ownerId: d.ownerId,
    visibility: d.visibility,
    client: d.client,
    description: d.description,
    status: d.status,
    ...(d.code?.length ? { code: d.code } : {}),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ── Where things live (docs/multi-user.md "Private vs shared") ──────────────

export type Placement = { ownerId: string; visibility: Visibility };

/**
 * A task or note in this project (or in none): with no project it is private to its owner; in a private project it
 * belongs to the project's owner; in a shared project it is shared and keeps its own owner.
 */
export function placeIn(project: Pick<ProjectDoc, 'ownerId' | 'visibility'> | null, owner: string): Placement {
  if (!project) return { ownerId: owner, visibility: 'private' };
  if (project.visibility === 'private') return { ownerId: project.ownerId, visibility: 'private' };
  return { ownerId: owner, visibility: 'org' };
}


async function noteTree(c: Collections, rootIds: string[]): Promise<string[]> {
  const out = [...rootIds];
  let frontier = rootIds;
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const kids = await c.notes.find({ parentId: { $in: frontier } }, { projection: { _id: 1 } }).toArray();
    frontier = kids.map(k => k._id).filter(id => !out.includes(id));
    out.push(...frontier);
  }
  return out;
}

/** Moves notes (with their sub-pages) to a placement. */
export async function placeNotes(c: Collections, rootIds: string[], p: Placement): Promise<void> {
  if (!rootIds.length) return;
  await c.notes.updateMany({ _id: { $in: await noteTree(c, rootIds) } }, { $set: p });
}

/** Moves tasks with their history and notes to a placement. */
export async function placeTasks(c: Collections, taskIds: string[], p: Placement): Promise<void> {
  if (!taskIds.length) return;
  await c.tasks.updateMany({ _id: { $in: taskIds } }, { $set: p });
  await c.activity.updateMany({ taskId: { $in: taskIds } }, { $set: p });
  const notes = await c.notes.find({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }).toArray();
  await placeNotes(c, notes.map(n => n._id), p);
}

// ── Lookups ─────────────────────────────────────────────────────────────────

async function findProjectDoc(c: Collections, nameOrId: string): Promise<ProjectDoc | null> {
  const key = nameOrId.trim();
  if (!key) return null;
  const hits = await c.projects.find({ $or: [{ _id: key }, { nameLower: key.toLowerCase() }, { _id: slugify(key) }] }).limit(5).toArray();
  // An id wins; then a name. Two visible projects can share a name only when one is your own private project and a
  // teammate later made a shared one of that name (they could not see yours): your own is the one you mean.
  return hits.find(p => p._id === key) ?? hits.find(p => p.visibility === 'private') ?? hits[0] ?? null;
}

/**
 * Names (docs/multi-user.md "Project names"): unique among the projects the person can see, so nobody learns the name
 * of someone else's private project by being refused. Indexes back this up: one name per organization among shared
 * projects, one per owner among private ones.
 */
async function assertNameFree(c: Collections, nameLower: string, except?: string): Promise<void> {
  const other = await c.projects.findOne({ nameLower, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { _id: 1 } });
  if (other) throw new InputError('You already have a project with that name');
}

/** New ids: the name's slug plus a random tail. Ids are global, so a plain slug (or a -2 suffix) would tell one organization what another has named. */
function newProjectId(name: string): string {
  return `${slugify(name).slice(0, 48)}-${randomBytes(4).toString('hex')}`;
}

async function insertProject(
  c: Collections,
  s: Scope,
  data: { name: string; client?: string; description?: string; status?: ProjectDoc['status']; code?: CodeLocation[] | null; visibility?: Visibility },
): Promise<ProjectDoc> {
  const now = new Date();
  const nameLower = data.name.trim().toLowerCase();
  await assertNameFree(c, nameLower);
  for (let i = 1; i < 10; i++) {
    const _id = newProjectId(data.name);
    // Check first: inside a transaction a duplicate-key error would abort the whole batch.
    if (await idTaken('projects', _id)) continue;
    const doc: ProjectDoc = {
      _id,
      orgId: s.orgId,
      ownerId: s.userId,
      visibility: data.visibility ?? 'org',
      name: data.name.trim(),
      nameLower,
      client: data.client?.trim() ?? '',
      description: data.description ?? '',
      status: data.status ?? 'active',
      ...(data.code?.length ? { code: cleanCodeLocations(data.code) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await c.projects.insertOne(doc);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // Same name created concurrently → return that one; otherwise the id was taken meanwhile, try another.
      const existing = await c.projects.findOne({ nameLower });
      if (existing) return existing;
    }
  }
  throw new Error('Could not allocate a project id');
}

/** Find a project by id or (case-insensitive) name among the ones the caller sees; optionally create it. */
export async function resolveProject(
  c: Collections,
  s: Scope,
  nameOrId: string,
  opts: { create: boolean },
): Promise<ProjectDoc | null> {
  const found = await findProjectDoc(c, nameOrId);
  if (found || !opts.create) return found;
  return insertProject(c, s, { name: nameOrId });
}

export async function getProject(s: Scope, nameOrId: string): Promise<Project | null> {
  const c = await scoped(s);
  const d = await findProjectDoc(c, nameOrId);
  return d ? toProject(d) : null;
}

export async function listProjectsBasic(s: Scope): Promise<Project[]> {
  const c = await scoped(s);
  const docs = await c.projects.find({}).sort({ nameLower: 1 }).toArray();
  return docs.map(toProject);
}

/** Just id, name and status, by name (the sidebar and pickers). */
export async function listProjectsNav(s: Scope): Promise<Pick<Project, 'id' | 'name' | 'status'>[]> {
  const c = await scoped(s);
  const docs = await c.projects.find({}, { projection: { name: 1, status: 1 } }).sort({ nameLower: 1 }).toArray();
  return docs.map(d => ({ id: d._id, name: d.name, status: d.status }));
}

export async function projectNameMap(s: Scope, c?: Collections): Promise<Map<string, string>> {
  c ??= await scoped(s);
  const docs = await c.projects.find({}, { projection: { name: 1 } }).toArray();
  return new Map(docs.map(d => [d._id, d.name]));
}

function computeStats(tasks: Pick<TaskDoc, 'status' | 'due' | 'doneOn' | 'estimateMins' | 'updatedAt'>[]): ProjectStats {
  const today = todayStr();
  const wk = weekStart(today);
  const s: ProjectStats = {
    open: 0,
    inProgress: 0,
    blocked: 0,
    overdue: 0,
    done: 0,
    dropped: 0,
    doneThisWeek: 0,
    openEstimateMins: 0,
    completion: 0,
    lastActivityAt: null,
  };
  let last = 0;
  for (const t of tasks) {
    last = Math.max(last, t.updatedAt.getTime());
    if (t.status === 'Done') {
      s.done++;
      if (t.doneOn && t.doneOn >= wk) s.doneThisWeek++;
    } else if (t.status === 'Dropped') {
      s.dropped++;
    } else {
      s.open++;
      if (t.status === 'In Progress') s.inProgress++;
      if (t.status === 'Blocked') s.blocked++;
      if (t.due && t.due < today) s.overdue++;
      s.openEstimateMins += t.estimateMins ?? 0;
    }
  }
  s.completion = s.done + s.open > 0 ? Math.round((s.done / (s.done + s.open)) * 100) : 0;
  s.lastActivityAt = last ? new Date(last).toISOString() : null;
  return s;
}

function statsFromGroups(groups: { _id: { s: TaskDoc['status'] }; n: number; last: Date; overdue: number; doneWk: number; est: number }[]): ProjectStats {
  const s: ProjectStats = { open: 0, inProgress: 0, blocked: 0, overdue: 0, done: 0, dropped: 0, doneThisWeek: 0, openEstimateMins: 0, completion: 0, lastActivityAt: null };
  let last = 0;
  for (const g of groups) {
    last = Math.max(last, g.last.getTime());
    const st = g._id.s;
    if (st === 'Done') {
      s.done += g.n;
      s.doneThisWeek += g.doneWk;
    } else if (st === 'Dropped') {
      s.dropped += g.n;
    } else {
      s.open += g.n;
      if (st === 'In Progress') s.inProgress += g.n;
      if (st === 'Blocked') s.blocked += g.n;
      s.overdue += g.overdue;
      s.openEstimateMins += g.est;
    }
  }
  s.completion = s.done + s.open > 0 ? Math.round((s.done / (s.done + s.open)) * 100) : 0;
  s.lastActivityAt = last ? new Date(last).toISOString() : null;
  return s;
}

export async function listProjects(s: Scope, opts: { includeInactive?: boolean } = {}): Promise<ProjectWithStats[]> {
  const c = await scoped(s);
  const filter = opts.includeInactive ? {} : { status: { $in: ['active', 'paused'] as ProjectDoc['status'][] } };
  const today = todayStr();
  const wk = weekStart(today);
  const flag = (cond: object) => ({ $sum: { $cond: [cond, 1, 0] } });
  // Counted in the database per project and status: no task documents travel.
  const [projects, groups] = await Promise.all([
    c.projects.find(filter).toArray(),
    c.tasks
      .aggregate<{ _id: { p: string; s: TaskDoc['status'] }; n: number; last: Date; overdue: number; doneWk: number; est: number }>([
        { $match: { archived: false, projectId: { $ne: null } } },
        {
          $group: {
            _id: { p: '$projectId', s: '$status' },
            n: { $sum: 1 },
            last: { $max: '$updatedAt' },
            overdue: flag({ $and: [{ $gt: ['$due', ''] }, { $lt: ['$due', today] }] }),
            doneWk: flag({ $and: [{ $gt: ['$doneOn', ''] }, { $gte: ['$doneOn', wk] }] }),
            est: { $sum: { $ifNull: ['$estimateMins', 0] } },
          },
        },
      ])
      .toArray(),
  ]);
  const byProject = new Map<string, typeof groups>();
  for (const g of groups) byProject.set(g._id.p, [...(byProject.get(g._id.p) ?? []), g]);
  return projects
    .map(p => ({ ...toProject(p), stats: statsFromGroups(byProject.get(p._id) ?? []) }))
    .sort((a, b) => {
      const order = { active: 0, paused: 1, done: 2, archived: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.stats.open !== b.stats.open) return b.stats.open - a.stats.open;
      return a.name.localeCompare(b.name);
    });
}

export async function getProjectWithStats(s: Scope, nameOrId: string): Promise<ProjectWithStats | null> {
  const c = await scoped(s);
  const p = await findProjectDoc(c, nameOrId);
  if (!p) return null;
  const tasks = await c.tasks
    .find({ archived: false, projectId: p._id }, { projection: { status: 1, due: 1, doneOn: 1, estimateMins: 1, updatedAt: 1 } })
    .toArray();
  return { ...toProject(p), stats: computeStats(tasks) };
}

/** Creates a project; if one the caller sees has that name, returns it with created=false. */
export async function createProject(s: Scope, input: ProjectInput): Promise<{ project: Project; created: boolean }> {
  const data = ProjectInputSchema.parse(input);
  const c = await scoped(s);
  const existing = await c.projects.findOne({ nameLower: data.name.toLowerCase() });
  if (existing) return { project: toProject(existing), created: false };
  const doc = await insertProject(c, s, data);
  return { project: toProject(doc), created: true };
}

export async function updateProject(s: Scope, id: string, patch: Partial<ProjectInput>): Promise<Project> {
  const data = ProjectInputSchema.partial().parse(patch);
  const c = await scoped(s);
  const cur = await c.projects.findOne({ _id: id });
  if (!cur) throw new NotFoundError(`Project "${id}" not found`);
  const set: Partial<ProjectDoc> = { updatedAt: new Date() };
  if (data.name !== undefined && data.name !== cur.name) {
    await assertNameFree(c, data.name.toLowerCase(), id);
    set.name = data.name;
    set.nameLower = data.name.toLowerCase();
  }
  if (data.client !== undefined) set.client = data.client;
  if (data.description !== undefined) set.description = data.description;
  if (data.status !== undefined) set.status = data.status;
  if (data.code !== undefined) set.code = cleanCodeLocations(data.code);
  if (data.visibility !== undefined && data.visibility !== cur.visibility) {
    if (cur.ownerId !== s.userId) throw new InputError("Only the project's owner can make it private or shared");
    // Made shared: the name must be free among the organization's shared projects (all visible to the owner already,
    // so this refusal tells them nothing new). Someone else's private project of that name does not count.
    if (data.visibility === 'org' && (await c.projects.findOne({ _id: { $ne: id }, nameLower: set.nameLower ?? cur.nameLower, visibility: 'org' }, { projection: { _id: 1 } }))) {
      throw new InputError('A shared project with that name already exists');
    }
    // Made private: the name must be free among the owner's own private projects (all theirs, so nothing leaks). Checked
    // first: the cascade below is not undone if the project's own update then failed on the unique index.
    if (data.visibility === 'private' && (await c.projects.findOne({ _id: { $ne: id }, nameLower: set.nameLower ?? cur.nameLower, visibility: 'private', ownerId: cur.ownerId }, { projection: { _id: 1 } }))) {
      throw new InputError('You already have a private project with that name. Rename one of them first.');
    }
    set.visibility = data.visibility;
    await setProjectVisibility(c, cur, data.visibility);
  }
  await c.projects.updateOne({ _id: id }, { $set: set });
  return toProject({ ...cur, ...set });
}

/**
 * Everything in the project follows it. Made private: its tasks, notes, Claude items, history and trash belong to the
 * project's owner and only they see them. Made shared again: the organization sees them (owners stay).
 */
async function setProjectVisibility(c: Collections, p: ProjectDoc, visibility: Visibility): Promise<void> {
  const owned = visibility === 'private' ? { ownerId: p.ownerId, visibility } : { visibility };
  // Trashed tasks too: their history (the "trashed" line) and notes stay in place while the task is in the trash.
  const taskIds = [...(await c.tasks.distinct('_id', { projectId: p._id })), ...(await c.trash.distinct('_id', { 'task.projectId': p._id }))];
  if (taskIds.length) {
    await c.tasks.updateMany({ _id: { $in: taskIds } }, { $set: owned });
    // A private task can be assigned only to its owner (docs/multi-user.md phase 4).
    if (visibility === 'private') await c.tasks.updateMany({ _id: { $in: taskIds }, assigneeId: { $nin: [null, p.ownerId] } }, { $set: { assigneeId: null } });
    await c.activity.updateMany({ taskId: { $in: taskIds } }, { $set: owned });
    const taskNotes = await c.notes.find({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }).toArray();
    if (taskNotes.length) await c.notes.updateMany({ _id: { $in: await noteTree(c, taskNotes.map(n => n._id)) } }, { $set: owned });
  }
  const projNotes = await c.notes.find({ projectId: p._id, taskId: null }, { projection: { _id: 1 } }).toArray();
  if (projNotes.length) await c.notes.updateMany({ _id: { $in: await noteTree(c, projNotes.map(n => n._id)) } }, { $set: owned });
  await c.claudeItems.updateMany({ projectId: p._id }, { $set: owned });
  await c.trash.updateMany({ 'task.projectId': p._id }, { $set: owned });
}

export type ProjectByCode =
  | { matched: true; project: Project; how: string; location: CodeLocation }
  | { matched: false; candidates: { id: string; name: string; similarity: number }[] };

/** The project whose code locations best match a git remote / subdir / branch / folder path. */
export async function findProjectByCode(s: Scope, q: CodeQuery): Promise<ProjectByCode> {
  const c = await scoped(s);
  const docs = await c.projects.find({}, { projection: { name: 1, code: 1, status: 1 } }).toArray();
  const list = docs.map(d => ({ id: d._id, name: d.name, code: d.code }));
  const m = matchCodeLocation(list, q);
  if (m) {
    const doc = await c.projects.findOne({ _id: m.project.id });
    if (doc) return { matched: true, project: toProject(doc), how: m.how, location: m.location };
  }
  const live = list.filter((_, i) => docs[i].status === 'active' || docs[i].status === 'paused');
  return { matched: false, candidates: codeCandidates(live.length ? live : list, q).map(x => ({ id: x.project.id, name: x.project.name, similarity: x.similarity })) };
}
