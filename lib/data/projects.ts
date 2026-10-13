import 'server-only';
import { collections, type Collections, type ProjectDoc, type TaskDoc } from '../db';
import {
  ProjectInputSchema,
  type Project,
  type ProjectInput,
  type ProjectStats,
  type ProjectWithStats,
} from '../types';
import { todayStr, weekStart } from '../dates';
import { InputError, NotFoundError } from './errors';

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
    client: d.client,
    description: d.description,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function findProjectDoc(c: Collections, nameOrId: string): Promise<ProjectDoc | null> {
  const key = nameOrId.trim();
  if (!key) return null;
  return c.projects.findOne({
    $or: [{ _id: key }, { nameLower: key.toLowerCase() }, { _id: slugify(key) }],
  });
}

async function insertProject(
  c: Collections,
  data: { name: string; client?: string; description?: string; status?: ProjectDoc['status'] },
): Promise<ProjectDoc> {
  const base = slugify(data.name);
  const now = new Date();
  for (let i = 1; i < 50; i++) {
    const doc: ProjectDoc = {
      _id: i === 1 ? base : `${base}-${i}`,
      name: data.name.trim(),
      nameLower: data.name.trim().toLowerCase(),
      client: data.client?.trim() ?? '',
      description: data.description ?? '',
      status: data.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    if (await c.projects.findOne({ _id: doc._id }, { projection: { _id: 1 } })) continue;
    try {
      await c.projects.insertOne(doc);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // Same name created concurrently → return that one; otherwise the slug is taken, try the next.
      const existing = await c.projects.findOne({ nameLower: doc.nameLower });
      if (existing) return existing;
    }
  }
  throw new Error('Could not allocate a project id');
}

/** Find a project by id or (case-insensitive) name; optionally create it. */
export async function resolveProject(
  c: Collections,
  nameOrId: string,
  opts: { create: boolean },
): Promise<ProjectDoc | null> {
  const found = await findProjectDoc(c, nameOrId);
  if (found || !opts.create) return found;
  return insertProject(c, { name: nameOrId });
}

export async function getProject(nameOrId: string): Promise<Project | null> {
  const c = await collections();
  const d = await findProjectDoc(c, nameOrId);
  return d ? toProject(d) : null;
}

export async function listProjectsBasic(): Promise<Project[]> {
  const c = await collections();
  const docs = await c.projects.find({}).sort({ nameLower: 1 }).toArray();
  return docs.map(toProject);
}

export async function projectNameMap(c?: Collections): Promise<Map<string, string>> {
  c ??= await collections();
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

export async function listProjects(opts: { includeInactive?: boolean } = {}): Promise<ProjectWithStats[]> {
  const c = await collections();
  const filter = opts.includeInactive ? {} : { status: { $in: ['active', 'paused'] as ProjectDoc['status'][] } };
  const [projects, tasks] = await Promise.all([
    c.projects.find(filter).toArray(),
    c.tasks
      .find(
        { archived: false, projectId: { $ne: null } },
        { projection: { projectId: 1, status: 1, due: 1, doneOn: 1, estimateMins: 1, updatedAt: 1 } },
      )
      .toArray(),
  ]);
  const byProject = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const list = byProject.get(t.projectId!) ?? [];
    list.push(t);
    byProject.set(t.projectId!, list);
  }
  return projects
    .map(p => ({ ...toProject(p), stats: computeStats(byProject.get(p._id) ?? []) }))
    .sort((a, b) => {
      const order = { active: 0, paused: 1, done: 2, archived: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.stats.open !== b.stats.open) return b.stats.open - a.stats.open;
      return a.name.localeCompare(b.name);
    });
}

export async function getProjectWithStats(nameOrId: string): Promise<ProjectWithStats | null> {
  const c = await collections();
  const p = await findProjectDoc(c, nameOrId);
  if (!p) return null;
  const tasks = await c.tasks
    .find({ archived: false, projectId: p._id }, { projection: { status: 1, due: 1, doneOn: 1, estimateMins: 1, updatedAt: 1 } })
    .toArray();
  return { ...toProject(p), stats: computeStats(tasks) };
}

/** Creates a project; if one with that name exists, returns it with created=false. */
export async function createProject(input: ProjectInput): Promise<{ project: Project; created: boolean }> {
  const data = ProjectInputSchema.parse(input);
  const c = await collections();
  const existing = await c.projects.findOne({ nameLower: data.name.toLowerCase() });
  if (existing) return { project: toProject(existing), created: false };
  const doc = await insertProject(c, data);
  return { project: toProject(doc), created: true };
}

export async function updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
  const data = ProjectInputSchema.partial().parse(patch);
  const c = await collections();
  const cur = await c.projects.findOne({ _id: id });
  if (!cur) throw new NotFoundError(`Project "${id}" not found`);
  const set: Partial<ProjectDoc> = { updatedAt: new Date() };
  if (data.name !== undefined && data.name !== cur.name) {
    const clash = await c.projects.findOne({ nameLower: data.name.toLowerCase(), _id: { $ne: id } });
    if (clash) throw new InputError(`A project named "${data.name}" already exists`);
    set.name = data.name;
    set.nameLower = data.name.toLowerCase();
  }
  if (data.client !== undefined) set.client = data.client;
  if (data.description !== undefined) set.description = data.description;
  if (data.status !== undefined) set.status = data.status;
  await c.projects.updateOne({ _id: id }, { $set: set });
  return toProject({ ...cur, ...set });
}
