import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { collections, type Collections, type NoteDoc } from '../db';
import { CLOSED_STATUSES, type Actor } from '../types';
import type { NoteBlock } from '../notes-schema';
import { blockOutline, blocksToMarkdown, cloneBlocks, findBlock, markdownToBlocks, plainText } from '../notes-convert';
import { InputError, NotFoundError } from './errors';
import { resolveProject } from './projects';

// Notes are Notion-style pages (editor blocks) attached to a task or a project, optionally
// nested as sub-pages. Blocks are the source of truth; `body` is derived markdown used for
// search, previews and Claude.
// - A task has at most one note (unique index); addressing a note by its task always hits it.
// - Everything else is addressed by note id. Titles are never used to match.
// - A task note is archived while its task is Done/Dropped/archived; a project note when its
//   project is done/archived or the note is archived; a sub-page follows its root page.
// - Deleting is soft (30 days) and takes sub-pages with it.

export const NOTE_TRASH_DAYS = 30;

export type NoteRef = {
  id: string;
  title: string;
  firstLine: string;
  chars: number;
  updatedAt: string;
  updatedBy: Actor;
};

export type Note = NoteRef & {
  body: string;
  taskId: string | null;
  taskRef: number | null;
  taskTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  parentId: string | null;
  parentTitle: string | null;
  subPages: { id: string; title: string }[];
  archived: boolean;
  archivedBecause?: string;
  createdAt: string;
  createdBy: Actor;
};

const live: Filter<NoteDoc> = { deletedAt: null };

function firstLineOf(text: string): string {
  const l = text.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  return l.length > 140 ? l.slice(0, 139) + '…' : l;
}

export function noteRef(d: NoteDoc): NoteRef {
  const text = d.blocks?.length ? plainText(d.blocks as NoteBlock[]) : d.body.replace(/^[#>*\-\s\d.[\]x|]+/gm, '');
  return {
    id: d._id,
    title: d.title,
    firstLine: firstLineOf(text),
    chars: d.body.length,
    updatedAt: d.updatedAt.toISOString(),
    updatedBy: d.updatedBy,
  };
}

/** Blocks of a note, converting legacy markdown-only notes on the fly. */
export async function noteBlocks(d: NoteDoc): Promise<NoteBlock[]> {
  if (d.blocks?.length) return d.blocks as NoteBlock[];
  return d.body.trim() ? markdownToBlocks(d.body) : [];
}

async function hydrate(c: Collections, docs: NoteDoc[]): Promise<Note[]> {
  // Sub-pages take archive state and attachment from their root page.
  const parentIds = [...new Set(docs.map(d => d.parentId).filter((x): x is string => !!x))];
  const parents = parentIds.length ? new Map((await c.notes.find({ _id: { $in: parentIds } }).toArray()).map(p => [p._id, p])) : new Map<string, NoteDoc>();
  const rootOf = async (d: NoteDoc): Promise<NoteDoc> => {
    let cur = d;
    for (let i = 0; i < 10 && cur.parentId; i++) {
      const p = parents.get(cur.parentId) ?? (await c.notes.findOne({ _id: cur.parentId }));
      if (!p) break;
      parents.set(p._id, p);
      cur = p;
    }
    return cur;
  };
  const roots = new Map<string, NoteDoc>();
  for (const d of docs) roots.set(d._id, await rootOf(d));

  const taskIds = [...new Set([...roots.values()].map(r => r.taskId).filter((x): x is string => !!x))];
  const tasks = taskIds.length
    ? new Map((await c.tasks.find({ _id: { $in: taskIds } }, { projection: { ref: 1, title: 1, status: 1, archived: 1, projectId: 1 } }).toArray()).map(t => [t._id, t]))
    : new Map();
  const projIds = [
    ...new Set(
      docs
        .map(d => d.projectId ?? (roots.get(d._id)?.taskId ? tasks.get(roots.get(d._id)!.taskId!)?.projectId : null))
        .filter((x): x is string => !!x),
    ),
  ];
  const projects = projIds.length ? new Map((await c.projects.find({ _id: { $in: projIds } }).toArray()).map(p => [p._id, p])) : new Map();
  const kids = await c.notes
    .find({ parentId: { $in: docs.map(d => d._id) }, ...live }, { projection: { _id: 1, title: 1, parentId: 1 } })
    .toArray();

  return docs.map(d => {
    const root = roots.get(d._id)!;
    const t = root.taskId ? tasks.get(root.taskId) : undefined;
    const pid = d.projectId ?? t?.projectId ?? null;
    const p = pid ? projects.get(pid) : undefined;
    let because: string | undefined;
    if (d.archived || root.archived) because = 'archived';
    else if (t && (CLOSED_STATUSES.includes(t.status) || t.archived)) because = 'task closed';
    else if (!root.taskId && p && (p.status === 'done' || p.status === 'archived')) because = 'project closed';
    return {
      ...noteRef(d),
      body: d.body,
      taskId: d.taskId,
      taskRef: d.taskId ? (t?.ref ?? null) : null,
      taskTitle: d.taskId ? (t?.title ?? null) : null,
      projectId: pid,
      projectName: p?.name ?? null,
      parentId: d.parentId ?? null,
      parentTitle: d.parentId ? (parents.get(d.parentId)?.title ?? null) : null,
      subPages: kids.filter(k => k.parentId === d._id).map(k => ({ id: k._id, title: k.title })),
      archived: !!because,
      ...(because ? { archivedBecause: because } : {}),
      createdAt: d.createdAt.toISOString(),
      createdBy: d.createdBy,
    };
  });
}

async function taskIdFor(c: Collections, key: string | number): Promise<{ _id: string; ref: number; title: string; projectId: string | null }> {
  const f = typeof key === 'number' ? { ref: key } : /^#?\d{1,7}$/.test(key.trim()) ? { ref: Number(key.trim().replace('#', '')) } : { _id: key.trim() };
  const t = await c.tasks.findOne(f, { projection: { ref: 1, title: 1, projectId: 1 } });
  if (!t) throw new NotFoundError(`Task ${key} not found`);
  return t;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getNote(id: string): Promise<Note | null> {
  const c = await collections();
  const d = await c.notes.findOne({ _id: id, ...live });
  return d ? (await hydrate(c, [d]))[0] : null;
}

/** Note plus its editor blocks (for the editor) and a per-block outline (for Claude). */
export async function getNoteWithBlocks(id: string, opts: { outline?: boolean } = {}) {
  const c = await collections();
  const d = await c.notes.findOne({ _id: id, ...live });
  if (!d) return null;
  const [note] = await hydrate(c, [d]);
  const blocks = await noteBlocks(d);
  return { note, blocks, ...(opts.outline ? { outline: await blockOutline(blocks) } : {}) };
}

export async function getTaskNoteId(key: string | number): Promise<string | null> {
  const c = await collections();
  const t = await taskIdFor(c, key);
  return (await c.notes.findOne({ taskId: t._id, ...live }, { projection: { _id: 1 } }))?._id ?? null;
}

export type NoteFilter = {
  project?: string;
  state?: 'active' | 'archived' | 'all';
  kind?: 'task' | 'project' | 'all';
  q?: string;
  limit?: number;
};

export async function listNotes(f: NoteFilter = {}): Promise<{ total: number; notes: Note[] }> {
  const c = await collections();
  const q: Filter<NoteDoc> = { ...live };
  if (f.kind === 'task') q.taskId = { $ne: null };
  if (f.kind === 'project') q.taskId = null;
  if (f.q?.trim()) {
    const re = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ title: re }, { body: re }];
  }
  const docs = await c.notes.find(q, { projection: { blocks: 0 } }).sort({ updatedAt: -1 }).toArray();
  let notes = await hydrate(c, docs);
  if (f.project) {
    const p = await resolveProject(c, f.project, { create: false });
    notes = p ? notes.filter(n => n.projectId === p._id) : [];
  }
  const state = f.state ?? 'active';
  if (state !== 'all') notes = notes.filter(n => n.archived === (state === 'archived'));
  return { total: notes.length, notes: f.limit ? notes.slice(0, f.limit) : notes };
}

/** Compact index of top-level notes per task id and per project id, for embedding in reads. */
export async function noteIndex(opts: { taskIds?: string[]; projectIds?: string[] }): Promise<{ byTask: Map<string, NoteRef>; byProject: Map<string, NoteRef[]> }> {
  const c = await collections();
  const or: Filter<NoteDoc>[] = [];
  if (opts.taskIds?.length) or.push({ taskId: { $in: opts.taskIds } });
  if (opts.projectIds?.length) or.push({ projectId: { $in: opts.projectIds }, taskId: null, parentId: { $in: [null, undefined] } });
  const byTask = new Map<string, NoteRef>();
  const byProject = new Map<string, NoteRef[]>();
  if (!or.length) return { byTask, byProject };
  const docs = await c.notes.find({ ...live, $or: or }).sort({ updatedAt: -1 }).toArray();
  for (const d of docs) {
    if (d.taskId) byTask.set(d.taskId, noteRef(d));
    else if (d.projectId) byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), noteRef(d)]);
  }
  return { byTask, byProject };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type BlockOp =
  | { op: 'replace'; block_id: string; markdown: string }
  | { op: 'insert'; after?: string; before?: string; markdown: string }
  | { op: 'delete'; block_id: string };

export type NoteWrite = {
  /** Update this note. */
  noteId?: string;
  /** The task's note (created if it has none). */
  task?: string | number;
  /** Create a new note on this project (when no noteId/task/parent). */
  project?: string;
  /** Create a new sub-page inside this note. */
  parentId?: string;
  title?: string;
  /** Editor blocks: replaces the whole page (used by the app's editor). */
  blocks?: unknown[];
  /** Markdown: replaces the whole page. */
  body?: string;
  /** Markdown added at the end. */
  append?: string;
  /** Per-block edits, applied in order. */
  blockOps?: BlockOp[];
  /** Text replacements; each `find` must occur in exactly one block, exactly once. Only that block is rewritten. */
  edits?: { find: string; replace: string }[];
  archived?: boolean;
  /** Sub-page only: false when the caller (the editor) inserts the page block itself. Default true. */
  linkInParent?: boolean;
  /** Optimistic concurrency: refuse if the note changed since this version (ISO updatedAt). */
  expectUpdatedAt?: string;
};

export class NoteConflictError extends InputError {
  constructor() {
    super('This page was changed elsewhere since you opened it.');
    this.name = 'NoteConflictError';
  }
}

async function applyContent(blocks: NoteBlock[], w: NoteWrite): Promise<NoteBlock[] | null> {
  const modes = [w.blocks !== undefined, w.body !== undefined, w.append !== undefined, !!w.blockOps?.length, !!w.edits?.length].filter(Boolean).length;
  if (modes > 1) throw new InputError('Use one of blocks, body, append, block_ops or edits per write.');
  if (w.blocks !== undefined) {
    if (!Array.isArray(w.blocks)) throw new InputError('blocks must be an array');
    return w.blocks as NoteBlock[];
  }
  if (w.body !== undefined) return markdownToBlocks(w.body);
  if (w.append !== undefined) return w.append.trim() ? [...blocks, ...(await markdownToBlocks(w.append))] : null;

  let out = cloneBlocks(blocks);
  for (const o of w.blockOps ?? []) {
    if (o.op === 'delete' || o.op === 'replace') {
      const loc = findBlock(out, o.block_id);
      if (!loc) throw new InputError(`Block ${o.block_id} not found (read the note again for current ids)`);
      if (o.op === 'delete') loc.list.splice(loc.index, 1);
      else {
        const nb = await markdownToBlocks(o.markdown);
        if (nb.length) nb[0] = { ...nb[0], id: o.block_id } as NoteBlock; // keep the id stable
        loc.list.splice(loc.index, 1, ...nb);
      }
    } else {
      const nb = await markdownToBlocks(o.markdown);
      const anchor = o.after ?? o.before;
      if (!anchor) out = o.before === undefined && o.after === undefined ? [...out, ...nb] : out;
      else {
        const loc = findBlock(out, anchor);
        if (!loc) throw new InputError(`Block ${anchor} not found`);
        loc.list.splice(o.after ? loc.index + 1 : loc.index, 0, ...nb);
      }
    }
  }
  for (const e of w.edits ?? []) {
    const outline = await blockOutline(out);
    // Exported lists use "*"; accept "-" too.
    const candidates = [e.find, e.find.replace(/^(\s*)- /gm, '$1* ')];
    let find = e.find;
    let hits: typeof outline = [];
    let count = 0;
    for (const f of candidates) {
      hits = outline.filter(x => x.markdown.includes(f));
      count = hits.reduce((n, x) => n + x.markdown.split(f).length - 1, 0);
      find = f;
      if (count) break;
    }
    if (count !== 1) throw new InputError(`Edit text ${count ? 'occurs ' + count + ' times' : 'not found'}: "${e.find.slice(0, 60)}". Make it unique, or use block_ops.`);
    const loc = findBlock(out, hits[0].id)!;
    const nb = await markdownToBlocks(hits[0].markdown.replace(find, () => e.replace.replace(/^(\s*)- /gm, '$1* ')));
    if (nb.length) nb[0] = { ...nb[0], id: hits[0].id } as NoteBlock;
    loc.list.splice(loc.index, 1, ...nb);
  }
  return w.blockOps?.length || w.edits?.length ? out : null;
}

function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** The dispatcher's boilerplate note is read by every session it starts, so only Om may change, move or delete it (or add a sub-page to it). */
async function guardBoilerplate(c: Collections, actor: Actor, ids: (string | null | undefined)[]): Promise<void> {
  if (actor === 'me') return;
  const s = await c.settings.findOne({ _id: 'dispatcher' }, { projection: { boilerplateNoteId: 1 } });
  if (s?.boilerplateNoteId && ids.includes(s.boilerplateNoteId)) throw new InputError("This note is the dispatcher's boilerplate; only Om can change it");
}

export async function writeNote(w: NoteWrite, actor: Actor): Promise<{ note: Note; created: boolean }> {
  const c = await collections();
  const now = new Date();

  let cur: NoteDoc | null = null;
  let taskId: string | null = null;
  let parent: NoteDoc | null = null;
  if (w.noteId) {
    cur = await c.notes.findOne({ _id: w.noteId, ...live });
    if (!cur) throw new NotFoundError(`Note ${w.noteId} not found`);
  } else if (w.task !== undefined) {
    const t = await taskIdFor(c, w.task);
    taskId = t._id;
    cur = await c.notes.findOne({ taskId, ...live });
    if (!cur && !w.title) w.title = t.title;
  } else if (w.parentId) {
    parent = await c.notes.findOne({ _id: w.parentId, ...live });
    if (!parent) throw new NotFoundError(`Parent note ${w.parentId} not found`);
  } else if (!w.project) {
    throw new InputError('Give note_id to update a note, task for a task’s note, parent_id for a sub-page, or project to create a project note.');
  }

  await guardBoilerplate(c, actor, [cur?._id, cur?.parentId, parent?._id]);
  if (cur) {
    if (w.expectUpdatedAt && cur.updatedAt.toISOString() !== w.expectUpdatedAt) throw new NoteConflictError();
    const next = await applyContent(await noteBlocks(cur), w);
    const set: Partial<NoteDoc> = { updatedAt: now, updatedBy: actor };
    if (next) {
      set.blocks = next;
      set.body = await blocksToMarkdown(next);
    }
    if (w.title?.trim() && w.title.trim() !== cur.title) {
      set.title = w.title.trim();
      if (cur.parentId) await renamePageBlock(c, cur.parentId, cur._id, set.title);
    }
    if (w.archived !== undefined) set.archived = w.archived;
    await c.notes.updateOne({ _id: cur._id }, { $set: set });
    return { note: (await hydrate(c, [{ ...cur, ...set }]))[0], created: false };
  }

  // Create
  if (w.edits?.length || w.blockOps?.length) throw new InputError('The note does not exist yet. Pass body instead.');
  let projectId: string | null = null;
  if (parent) {
    projectId = parent.projectId ?? (parent.taskId ? ((await c.tasks.findOne({ _id: parent.taskId }, { projection: { projectId: 1 } }))?.projectId ?? null) : null);
  } else if (!taskId) {
    const p = await resolveProject(c, w.project!, { create: false });
    if (!p) throw new NotFoundError(`Project "${w.project}" not found`);
    projectId = p._id;
    if (!w.title?.trim()) throw new InputError('A new project note needs a title.');
  }
  const blocks = (await applyContent([], { blocks: w.blocks, body: w.body ?? w.append })) ?? [];
  const doc: NoteDoc = {
    _id: newId(),
    title: (w.title ?? 'Untitled').trim() || 'Untitled',
    blocks,
    body: await blocksToMarkdown(blocks),
    parentId: parent?._id ?? null,
    taskId,
    projectId,
    archived: w.archived ?? false,
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
    deletedAt: null,
  };
  try {
    await c.notes.insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new InputError('That task already has a note; write to it by task or note id.');
    throw err;
  }
  if (parent && w.linkInParent !== false) await addPageBlock(c, parent, doc._id, doc.title, actor);
  return { note: (await hydrate(c, [doc]))[0], created: true };
}

async function addPageBlock(c: Collections, parent: NoteDoc, childId: string, title: string, actor: Actor) {
  const blocks = [...(await noteBlocks(parent)), { id: randomUUID(), type: 'page', props: { noteId: childId, title }, children: [] } as unknown as NoteBlock];
  await c.notes.updateOne({ _id: parent._id }, { $set: { blocks, body: await blocksToMarkdown(blocks), updatedAt: new Date(), updatedBy: actor } });
}

function mapPageBlocks(blocks: NoteBlock[], childId: string, fn: (b: NoteBlock) => NoteBlock | null): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const b of blocks) {
    const x = b as unknown as { type: string; props?: { noteId?: string }; children?: NoteBlock[] };
    const mapped = x.type === 'page' && x.props?.noteId === childId ? fn(b) : b;
    if (!mapped) continue;
    const kids = (mapped as unknown as { children?: NoteBlock[] }).children;
    out.push(kids?.length ? ({ ...mapped, children: mapPageBlocks(kids, childId, fn) } as NoteBlock) : mapped);
  }
  return out;
}

async function renamePageBlock(c: Collections, parentId: string, childId: string, title: string) {
  const p = await c.notes.findOne({ _id: parentId });
  if (!p?.blocks?.length) return;
  const blocks = mapPageBlocks(p.blocks as NoteBlock[], childId, b => ({ ...b, props: { ...(b.props as object), title } }) as NoteBlock);
  await c.notes.updateOne({ _id: parentId }, { $set: { blocks, body: await blocksToMarkdown(blocks), updatedAt: new Date() } });
}

async function descendants(c: Collections, id: string): Promise<string[]> {
  const out: string[] = [];
  let frontier = [id];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const kids = await c.notes.find({ parentId: { $in: frontier }, ...live }, { projection: { _id: 1 } }).toArray();
    frontier = kids.map(k => k._id);
    out.push(...frontier);
  }
  return out;
}

export async function deleteNote(id: string, actor: Actor, opts: { expectTitle?: string } = {}): Promise<{ title: string; subPages: number }> {
  const c = await collections();
  const cur = await c.notes.findOne({ _id: id, ...live });
  if (!cur) throw new NotFoundError(`Note ${id} not found`);
  if (opts.expectTitle !== undefined && cur.title.toLowerCase().trim() !== opts.expectTitle.toLowerCase().trim()) {
    throw new InputError(`Note ${id} is "${cur.title}", not "${opts.expectTitle}". Nothing deleted.`);
  }
  await guardBoilerplate(c, actor, [cur._id, cur.parentId]);
  const kids = await descendants(c, id);
  const at = new Date();
  await c.notes.updateMany({ _id: { $in: [id, ...kids] } }, { $set: { deletedAt: at, deletedBy: actor } });
  if (cur.parentId) {
    const p = await c.notes.findOne({ _id: cur.parentId });
    if (p?.blocks?.length) {
      const blocks = mapPageBlocks(p.blocks as NoteBlock[], id, () => null);
      await c.notes.updateOne({ _id: p._id }, { $set: { blocks, body: await blocksToMarkdown(blocks) } });
    }
  }
  return { title: cur.title, subPages: kids.length };
}

export async function restoreNote(id: string, actor: Actor): Promise<Note> {
  const c = await collections();
  const cur = await c.notes.findOne({ _id: id, deletedAt: { $ne: null } });
  if (!cur) throw new NotFoundError(`Note ${id} is not deleted`);
  await guardBoilerplate(c, actor, [cur._id, cur.parentId]);
  if (cur.taskId && (await c.notes.findOne({ taskId: cur.taskId, ...live }))) throw new InputError('That task has a newer note; restore refused.');
  // Bring back sub-pages deleted in the same action.
  const same = await c.notes.find({ deletedAt: cur.deletedAt }, { projection: { _id: 1 } }).toArray();
  await c.notes.updateMany({ _id: { $in: same.map(s => s._id) } }, { $set: { deletedAt: null }, $unset: { deletedBy: '' } });
  await c.notes.updateOne({ _id: id }, { $set: { updatedAt: new Date(), updatedBy: actor } });
  if (cur.parentId) {
    const p = await c.notes.findOne({ _id: cur.parentId, ...live });
    if (p) await addPageBlock(c, p, cur._id, cur.title, actor);
  }
  return (await getNote(id))!;
}

export async function purgeDeletedNotes(): Promise<number> {
  const c = await collections();
  const r = await c.notes.deleteMany({ deletedAt: { $ne: null, $lt: new Date(Date.now() - NOTE_TRASH_DAYS * 86_400_000) } });
  return r.deletedCount;
}
