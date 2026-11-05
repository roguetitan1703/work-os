import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Placed, ProjectDoc, TaskDoc } from '../db';
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
import { memberNames } from '../people';
import { cleanCodeLocations, codeCandidates, matchCodeLocation, type CodeQuery } from './code-locations';
import { assigneesOf, unassignableFilter, unassignPull } from '../assignees';
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
    ...(d.visibility === 'members' ? { sharedWith: d.sharedWith ?? [d.ownerId] } : {}),
    client: d.client,
    description: d.description,
    status: d.status,
    ...(d.code?.length ? { code: d.code } : {}),
    ...(d.nameBy ? { nameBy: d.nameBy } : {}),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ── Where things live (docs/multi-user.md "Private vs shared") ──────────────

/** Where a shared document lives: its owner, who sees it, and (visibility 'members') the list; [] otherwise. */
export type Placement = { ownerId: string; visibility: Visibility; sharedWith: string[] };

/**
 * A task or note in this project (or in none): with no project it is private to its owner; in a private project it
 * belongs to the project's owner; in a project shared with everyone it is shared and keeps its own owner; in one shared
 * with chosen people it carries the project's list and keeps its own owner while they are on it (else the project's
 * owner takes it, so nobody off the list sees it as its owner).
 */
export function placeIn(project: Pick<ProjectDoc, 'ownerId' | 'visibility' | 'sharedWith'> | null, owner: string): Placement {
  if (!project) return { ownerId: owner, visibility: 'private', sharedWith: [] };
  if (project.visibility === 'private') return { ownerId: project.ownerId, visibility: 'private', sharedWith: [] };
  if (project.visibility === 'members') {
    const list = projectList(project);
    return { ownerId: list.includes(owner) ? owner : project.ownerId, visibility: 'members', sharedWith: list };
  }
  return { ownerId: owner, visibility: 'org', sharedWith: [] };
}

/** The placement a stored document has now. */
export const placeOf = (d: Pick<Placed, 'ownerId' | 'visibility' | 'sharedWith'>): Placement => ({
  ownerId: d.ownerId,
  visibility: d.visibility,
  sharedWith: d.visibility === 'members' ? projectList(d) : [],
});

export const samePlace = (a: Placement, b: Placement): boolean =>
  a.ownerId === b.ownerId && a.visibility === b.visibility && a.sharedWith.length === b.sharedWith.length && a.sharedWith.every(u => b.sharedWith.includes(u));

/** A 'members' project's list: the owner first, then the people chosen (an older or odd document still holds its owner). */
function projectList(p: Pick<Placed, 'ownerId' | 'sharedWith'>): string[] {
  return [...new Set([p.ownerId, ...(p.sharedWith ?? []).filter(u => typeof u === 'string' && !!u)])];
}

/** sharedWith input (members' user ids or emails, or 'me') → user ids, the owner first. Someone outside the organization is refused. */
async function resolveList(s: Scope, ownerId: string, list: string[]): Promise<string[]> {
  const { findMember } = await import('../people');
  const out = [ownerId];
  for (const v of list) {
    const id = v.trim().toLowerCase() === 'me' ? s.userId : await findMember(s.orgId, v);
    if (!id) throw new InputError(`sharedWith: "${v.trim().slice(0, 80)}" is not a member of this organization`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
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
  // An id wins; then a name.
  return hits.find(p => p._id === key) ?? narrowest(hits);
}

/**
 * Of visible projects that share a name, the one you mean. They can share one only when a teammate who could not see
 * yours (your private project, or one shared with people they are not among) later made a shared one of that name: the
 * narrower one is yours, so work you put "in X" never lands where the whole organization sees it.
 */
function narrowest(hits: ProjectDoc[]): ProjectDoc | null {
  return hits.find(p => p.visibility === 'private') ?? hits.find(p => p.visibility === 'members') ?? hits[0] ?? null;
}

/** The visible project with this name (the narrowest, see above), or null. */
async function projectNamed(c: Collections, nameLower: string): Promise<ProjectDoc | null> {
  return narrowest(await c.projects.find({ nameLower }).limit(5).toArray());
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
  data: { name: string; client?: string; description?: string; status?: ProjectDoc['status']; code?: CodeLocation[] | null; visibility?: Visibility; sharedWith?: string[]; delpatOsId?: string },
): Promise<ProjectDoc> {
  const now = new Date();
  const nameLower = data.name.trim().toLowerCase();
  await assertNameFree(c, nameLower);
  const visibility = data.visibility ?? (data.sharedWith ? 'members' : 'org');
  if (data.sharedWith && visibility !== 'members') throw new InputError('sharedWith goes with visibility "members" (shared with chosen people)');
  const list = visibility === 'members' ? await resolveList(s, s.userId, data.sharedWith ?? []) : null;
  for (let i = 1; i < 10; i++) {
    const _id = newProjectId(data.name);
    // Check first: inside a transaction a duplicate-key error would abort the whole batch.
    if (await idTaken('projects', _id)) continue;
    const doc: ProjectDoc = {
      _id,
      orgId: s.orgId,
      ownerId: s.userId,
      visibility,
      ...(list ? { sharedWith: list } : {}),
      name: data.name.trim(),
      nameLower,
      nameBy: s.userId,
      client: data.client?.trim() ?? '',
      description: data.description ?? '',
      status: data.status ?? 'active',
      ...(data.delpatOsId ? { delpatOsId: data.delpatOsId } : {}),
      ...(data.code?.length ? { code: cleanCodeLocations(data.code), codeBy: s.userId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await c.projects.insertOne(doc);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // An import of the same Delpat OS project landed first (one the caller can see: shared, or their own private one).
      if (data.delpatOsId && (await c.projects.findOne({ delpatOsId: data.delpatOsId }, { projection: { _id: 1 } }))) {
        throw new InputError('That Delpat OS project was just imported. Reload to see it.');
      }
      // Same name created concurrently → return that one; otherwise the id was taken meanwhile, try another.
      const existing = await projectNamed(c, nameLower);
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
export async function listProjectsNav(s: Scope): Promise<Pick<Project, 'id' | 'name' | 'status' | 'visibility'>[]> {
  const c = await scoped(s);
  const docs = await c.projects.find({}, { projection: { name: 1, status: 1, visibility: 1 } }).sort({ nameLower: 1 }).toArray();
  return docs.map(d => ({ id: d._id, name: d.name, status: d.status, visibility: d.visibility }));
}

/** The sidebar's Recent: the projects the caller can see (active or paused), newest activity first (a task change or the project's own). */
export async function listRecentProjects(s: Scope, limit = 5): Promise<Pick<Project, 'id' | 'name' | 'visibility'>[]> {
  // Runs on every page, so it reads projects only (a handful of documents), never the tasks.
  const c = await scoped(s);
  const docs = await c.projects.find({ status: { $in: ['active', 'paused'] } }, { projection: { name: 1, visibility: 1, updatedAt: 1 } }).toArray();
  return docs
    .sort((x, y) => (y.updatedAt?.getTime() ?? 0) - (x.updatedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map(d => ({ id: d._id, name: d.name, visibility: d.visibility }));
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
  const existing = await projectNamed(c, data.name.toLowerCase());
  if (existing) return { project: toProject(existing), created: false };
  const doc = await insertProject(c, s, data);
  return { project: toProject(doc), created: true };
}

/** The caller's visible project already imported from this Delpat OS project, if any. */
export async function importedProject(s: Scope, delpatOsId: string): Promise<Project | null> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ delpatOsId });
  return p ? toProject(p) : null;
}

/** Which of these Delpat OS ids the caller already has in Work OS (visible projects only): id -> Work OS project id. */
export async function importedProjects(s: Scope, delpatOsIds: string[]): Promise<Record<string, string>> {
  if (!delpatOsIds.length) return {};
  const c = await scoped(s);
  const rows = await c.projects.find({ delpatOsId: { $in: delpatOsIds } }, { projection: { _id: 1, delpatOsId: 1 } }).toArray();
  return Object.fromEntries(rows.map(r => [String(r.delpatOsId), r._id]));
}

/**
 * Makes a project from a Delpat OS one (lib/delpat-os.ts). If the caller already sees an import of it (shared in the
 * organization, or their own private one) that one comes back (created=false). Someone else's private import does not
 * count and cannot block this one. A name that clashes with a project of the caller's gets " (Delpat OS)" added.
 */
export async function createImportedProject(
  s: Scope,
  data: { delpatOsId: string; name: string; client: string; description: string; status: ProjectDoc['status']; visibility: Visibility },
): Promise<{ project: Project; created: boolean }> {
  const c = await scoped(s);
  const seen = await c.projects.findOne({ delpatOsId: data.delpatOsId });
  if (seen) return { project: toProject(seen), created: false };
  const base = { client: data.client, description: data.description.slice(0, 5000), status: data.status, visibility: data.visibility, delpatOsId: data.delpatOsId };
  const name = data.name.trim().slice(0, 120) || 'Delpat OS project';
  const clash = async (n: string) => !!(await c.projects.findOne({ nameLower: n.toLowerCase() }, { projection: { _id: 1 } }));
  const finalName = (await clash(name)) ? `${name.slice(0, 100)} (Delpat OS)` : name;
  const doc = await insertProject(c, s, { ...base, name: finalName });
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
    // Who named it, for Claude's reads of a teammate-renamed project (lib/data/authors.ts).
    set.nameBy = s.userId;
  }
  if (data.client !== undefined) set.client = data.client;
  if (data.description !== undefined) set.description = data.description;
  if (data.status !== undefined) set.status = data.status;
  if (data.code !== undefined) {
    set.code = cleanCodeLocations(data.code);
    // Who set the repo: a PC clones it, and trusts the clone only when its owner set it (lib/data/turbo.ts).
    if (JSON.stringify(set.code) !== JSON.stringify(cur.code ?? [])) set.codeBy = s.userId;
  }
  // Who sees it: Shared with everyone ('org'), Shared with chosen people ('members' + sharedWith), Private. A list given
  // alone means "shared with these people"; 'members' alone keeps the current list.
  const nextVis: Visibility = data.visibility ?? (data.sharedWith !== undefined ? 'members' : cur.visibility);
  if (data.sharedWith !== undefined && nextVis !== 'members') throw new InputError('sharedWith goes with visibility "members" (shared with chosen people)');
  if (nextVis === 'members' && cur.visibility !== 'members' && data.sharedWith === undefined) throw new InputError('Say who sees it: pass sharedWith with visibility "members"');
  const was = placeOf(cur);
  const next: Placement = {
    ownerId: cur.ownerId,
    visibility: nextVis,
    sharedWith: nextVis !== 'members' ? [] : data.sharedWith !== undefined ? await resolveList(s, cur.ownerId, data.sharedWith) : was.sharedWith,
  };
  const moving = !samePlace(was, next);
  if (moving) {
    if (cur.ownerId !== s.userId) throw new InputError("Only the project's owner can change who sees it");
    if (next.visibility !== cur.visibility) await assertPlacementFree(c, cur, id, next.visibility, set.nameLower ?? cur.nameLower);
    set.visibility = next.visibility;
    set.sharedWith = next.sharedWith;
  }
  // Does anyone lose access? Then their Claude tasks and the waits on them end first (while they still see it), and what
  // follows the project moves before the project does, so a failure part-way leaves things placed narrower under a
  // wider project, never wider under a narrower one. Otherwise the project first, then what follows it, so a refused
  // update (a unique index) moves nothing.
  const cut = moving && cutsSomeone(was, next);
  if (cut) {
    const keep = next.visibility === 'private' ? [cur.ownerId] : next.sharedWith;
    await (await import('./dispatcher')).endForeignClaude(c, s, id, keep, next.visibility === 'private' ? 'project made private' : 'no longer shared with them');
    await setProjectPlacement(c, cur, next);
  }
  try {
    await c.projects.updateOne({ _id: id }, { $set: set });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new InputError('That change clashes with another project (its name or its Delpat OS import). Nothing was changed.');
    throw err;
  }
  if (moving && !cut) await setProjectPlacement(c, cur, next);
  return toProject({ ...cur, ...set });
}

/**
 * Someone left the organization: take them off every project list they are on (not their own projects), exactly as if
 * each project's owner had unticked them, so an invitation later does not quietly give the access back. c: the
 * organization without the visibility rule (lib/data/team.ts). Returns how many projects changed.
 */
export async function takeOffLists(c: Collections, orgId: string, userId: string): Promise<number> {
  const ps = await c.projects.find({ visibility: 'members', sharedWith: userId, ownerId: { $ne: userId } }).toArray();
  for (const p of ps) {
    const next: Placement = { ownerId: p.ownerId, visibility: 'members', sharedWith: placeOf(p).sharedWith.filter(u => u !== userId) };
    await (await import('./dispatcher')).endForeignClaude(c, { orgId, userId: p.ownerId }, p._id, next.sharedWith, 'no longer shared with them');
    await setProjectPlacement(c, p, next);
    await c.projects.updateOne({ _id: p._id }, { $set: { sharedWith: next.sharedWith, updatedAt: new Date() } });
  }
  return ps.length;
}

/** Does moving from one placement to another take access away from anyone? */
function cutsSomeone(was: Placement, next: Placement): boolean {
  if (was.visibility === 'private') return false;
  if (was.visibility === 'org') return next.visibility !== 'org';
  if (next.visibility === 'private') return true;
  return next.visibility === 'members' && was.sharedWith.some(u => !next.sharedWith.includes(u));
}

/**
 * The checks before a project changes visibility, so the cascade never runs for an update the unique indexes would then
 * refuse. Made shared with everyone: its name must be free among the organization's shared projects (all visible to the
 * owner already, so this refusal tells them nothing new); someone else's private project of that name does not count.
 * Made private: the name must be free among the owner's own private projects (all theirs, so nothing leaks). A list
 * ('members') has no index: its name is only checked among what the person sees. The same for a Delpat OS import.
 */
async function assertPlacementFree(c: Collections, cur: ProjectDoc, id: string, visibility: Visibility, nameLower: string): Promise<void> {
  if (visibility === 'members') return;
  if (visibility === 'org' && (await c.projects.findOne({ _id: { $ne: id }, nameLower, visibility: 'org' }, { projection: { _id: 1 } }))) {
    throw new InputError('A shared project with that name already exists');
  }
  if (visibility === 'private' && (await c.projects.findOne({ _id: { $ne: id }, nameLower, visibility: 'private', ownerId: cur.ownerId }, { projection: { _id: 1 } }))) {
    throw new InputError('You already have a private project with that name. Rename one of them first.');
  }
  if (cur.delpatOsId) {
    const clash = await c.projects.findOne(
      { _id: { $ne: id }, delpatOsId: cur.delpatOsId, ...(visibility === 'org' ? { visibility: 'org' } : { visibility: 'private', ownerId: cur.ownerId }) },
      { projection: { name: 1 } },
    );
    if (clash) {
      throw new InputError(visibility === 'org' ? `This Delpat OS project is already shared in Work OS as "${clash.name}".` : `You already have a private project imported from this Delpat OS project ("${clash.name}").`);
    }
  }
}

/**
 * Who a project's owner would cut off by changing who sees it (to Private, or to a list: `keep`): people assigned to its
 * tasks, people who commented on them, who gave its tasks to Claude, and whom its Claude items wait on.
 */
export async function projectSharingImpact(s: Scope, id: string, keep: string[] = []): Promise<{ assignees: string[]; commenters: string[]; claude: string[]; waiting: string[] }> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: id });
  if (!p) throw new NotFoundError(`Project "${id}" not found`);
  const stays = new Set([p.ownerId, ...keep]);
  const taskIds = [...(await c.tasks.distinct('_id', { projectId: id })), ...(await c.trash.distinct('_id', { 'task.projectId': id }))];
  const others = (ids: unknown[]) => [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x && !stays.has(x)))];
  const assignees = others([...(await c.tasks.distinct('assigneeIds', { projectId: id })), ...(await c.tasks.distinct('assigneeId', { projectId: id }))]);
  const commenters = others((await c.activity.distinct('actor.userId', { taskId: { $in: taskIds }, type: 'comment' })) as unknown[]);
  const claude = others(await c.tasks.distinct('claude.markedByUserId', { projectId: id, 'claude.state': { $in: ['queued', 'running'] } }));
  const waiting = others(await c.claudeItems.distinct('waitingOn', { projectId: id }));
  const names = await memberNames(s.orgId);
  const label = (u: string) => names[u] ?? 'Someone';
  return { assignees: assignees.map(label), commenters: commenters.map(label), claude: claude.map(label), waiting: waiting.map(label) };
}

/**
 * Everything in the project follows it: its tasks, notes, Claude items, history and trash. Made private: they belong to
 * the project's owner and only they see them. Shared with chosen people: they carry the list, and anything owned by
 * someone off the list goes to the project's owner (an owner always sees their own things). Shared with everyone: the
 * organization sees them (owners stay). Assignees who could not see their task there are removed.
 */
async function setProjectPlacement(c: Collections, p: ProjectDoc, next: Placement): Promise<void> {
  const owned = next.visibility === 'private' ? { ownerId: p.ownerId, visibility: next.visibility, sharedWith: [] } : { visibility: next.visibility, sharedWith: next.sharedWith };
  const offList = next.visibility === 'members' ? { ownerId: { $nin: next.sharedWith } } : null;
  // Off-list owners first: until the placement lands they are still placed as before (no one gains a way in meanwhile).
  const move = async (name: 'tasks' | 'activity' | 'notes' | 'claudeItems' | 'trash', filter: Record<string, unknown>) => {
    const col = c[name] as unknown as Collections['tasks'];
    if (offList) await col.updateMany({ ...filter, ...offList } as never, { $set: { ownerId: p.ownerId } });
    await col.updateMany(filter as never, { $set: owned });
  };
  // Trashed tasks too: their history (the "trashed" line) and notes stay in place while the task is in the trash.
  const taskIds = [...(await c.tasks.distinct('_id', { projectId: p._id })), ...(await c.trash.distinct('_id', { 'task.projectId': p._id }))];
  if (taskIds.length) {
    // Assignees who could not see their task there come off it (each of them; the others stay).
    const unassignable = unassignableFilter(next);
    if (unassignable) {
      // Tasks from before several assignees: the one old assignee moves into the list first.
      const old = await c.tasks.find({ _id: { $in: taskIds }, assigneeId: { $exists: true } }, { projection: { assigneeId: 1, assigneeIds: 1 } }).toArray();
      for (const t of old) await c.tasks.updateOne({ _id: t._id }, { $set: { assigneeIds: assigneesOf(t) }, $unset: { assigneeId: '' } });
      await c.tasks.updateMany({ _id: { $in: taskIds }, ...unassignable }, unassignPull(next));
    }
    await move('tasks', { _id: { $in: taskIds } });
    await move('activity', { taskId: { $in: taskIds } });
    const taskNotes = await c.notes.find({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }).toArray();
    if (taskNotes.length) await move('notes', { _id: { $in: await noteTree(c, taskNotes.map(n => n._id)) } });
  }
  const projNotes = await c.notes.find({ projectId: p._id, taskId: null }, { projection: { _id: 1 } }).toArray();
  if (projNotes.length) await move('notes', { _id: { $in: await noteTree(c, projNotes.map(n => n._id)) } });
  await move('claudeItems', { projectId: p._id });
  await move('trash', { 'task.projectId': p._id });
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
