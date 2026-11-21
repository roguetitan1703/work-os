import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import type { NoteDoc, TaskDoc } from '../db';
import { scoped, usersWithSetting, type Scope, type ScopedCollections as Collections } from '../scope';
import { actorUserId, asActor, isPerson } from '../actors';
import { CLOSED_STATUSES, type Actor } from '../types';
import type { NoteBlock } from '../notes-schema';
import { hasMarkdown, locate, locateExact, locateFolded, titleKey } from '../notes-match';
import { UNTITLED, shelfLabel, shelfOf, type Shelf } from '../notes-shelves';
import { blockOutline, blocksToMarkdown, cloneBlocks, editInPlace, findBlock, markdownToBlocks, plainText } from '../notes-convert';
import { requestContext } from '../request-context';
import { InputError, NotFoundError } from './errors';
import { placeIn, placeOf, resolveProject, type Placement } from './projects';
import { RETIRED } from '../mcp/docs';
import { canEditOrders, planVersion, ruleLines, ORG_RULE_LINES } from './orders';

// Notes are Notion-style pages (editor blocks) attached to a task or a project, optionally
// nested as sub-pages. Blocks are the source of truth; `body` is derived markdown used for
// search, previews and Claude.
// - A task has at most one note (unique index); addressing a note by its task always hits it.
// - Everything else is addressed by note id. Titles never address a note; they are compared only to refuse a duplicate among siblings.
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
  /** Only where the listing asked for it (noteIndex: a task's note, whose authors get_task labels). */
  createdBy?: Actor;
  /** The shelf of a top-level project note (lib/notes-shelves.ts); absent on a task's note and a sub-page. */
  shelf?: Shelf;
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
  /** Which layer of Orders this page is, if any (lib/data/orders.ts), and who owns it. */
  orders?: 'org' | 'project' | 'person';
  ownerId?: string;
  /** Who may read the page (the list and hydrate set it). */
  visibility?: 'org' | 'private' | 'members';
};

const live: Filter<NoteDoc> = { deletedAt: null };

function firstLineOf(text: string): string {
  const l = text.split('\n').map(s => s.trim()).find(Boolean) ?? '';
  return l.length > 140 ? l.slice(0, 139) + '…' : l;
}

/** A list read: `body` is only a prefix (enough for the first line) and `_chars` is the full length. */
type ListedNoteDoc = NoteDoc & { _chars?: number };

export function noteRef(d: ListedNoteDoc): NoteRef {
  const text = d.blocks?.length ? plainText(d.blocks as NoteBlock[]) : d.body.replace(/^[#>*\-\s\d.[\]x|]+/gm, '');
  return {
    id: d._id,
    title: d.title,
    firstLine: firstLineOf(text),
    chars: d._chars ?? d.body.length,
    updatedAt: d.updatedAt.toISOString(),
    updatedBy: asActor(d.updatedBy),
    ...(d.createdBy ? { createdBy: asActor(d.createdBy) } : {}),
    ...(d.projectId && shelfOf(d) ? { shelf: shelfOf(d)! } : {}),
  };
}

/** Blocks of a note, converting legacy markdown-only notes on the fly. */
export async function noteBlocks(d: NoteDoc): Promise<NoteBlock[]> {
  if (d.blocks?.length) return d.blocks as NoteBlock[];
  return d.body.trim() ? markdownToBlocks(d.body) : [];
}

// Parents and projects are only read for a few fields, never their blocks or code locations.
const PARENT_FIELDS = { title: 1, taskId: 1, archived: 1, parentId: 1, projectId: 1 } as const;
type ParentDoc = Pick<NoteDoc, '_id' | 'title' | 'taskId' | 'archived' | 'parentId' | 'projectId'>;

async function hydrate(c: Collections, docs: ListedNoteDoc[]): Promise<Note[]> {
  // Sub-pages take archive state and attachment from their root page.
  const parentIds = [...new Set(docs.map(d => d.parentId).filter((x): x is string => !!x))];
  const parents = parentIds.length
    ? new Map((await c.notes.find({ _id: { $in: parentIds } }, { projection: PARENT_FIELDS }).toArray()).map(p => [p._id, p as ParentDoc]))
    : new Map<string, ParentDoc>();
  const rootOf = async (d: ListedNoteDoc): Promise<ParentDoc> => {
    let cur: ParentDoc = d;
    for (let i = 0; i < 10 && cur.parentId; i++) {
      const p = parents.get(cur.parentId) ?? ((await c.notes.findOne({ _id: cur.parentId }, { projection: PARENT_FIELDS })) as ParentDoc | null);
      if (!p) break;
      parents.set(p._id, p);
      cur = p;
    }
    return cur;
  };
  const roots = new Map<string, ParentDoc>();
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
  const projects = projIds.length ? new Map((await c.projects.find({ _id: { $in: projIds } }, { projection: { name: 1, status: 1 } }).toArray()).map(p => [p._id, p])) : new Map();
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
      createdBy: asActor(d.createdBy),
      ...(d.orders ? { orders: d.orders } : {}),
      ownerId: d.ownerId,
      ...(d.visibility ? { visibility: d.visibility } : {}),
    };
  });
}

async function taskIdFor(c: Collections, key: string | number): Promise<{ _id: string; ref: number; title: string; projectId: string | null } & Pick<TaskDoc, 'ownerId' | 'visibility' | 'sharedWith'>> {
  const f = typeof key === 'number' ? { ref: key } : /^#?\d{1,7}$/.test(key.trim()) ? { ref: Number(key.trim().replace('#', '')) } : { _id: key.trim() };
  const t = await c.tasks.findOne(f, { projection: { ref: 1, title: 1, projectId: 1, ownerId: 1, visibility: 1, sharedWith: 1 } });
  if (!t) throw new NotFoundError(`Task ${key} not found`);
  return t;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getNote(s: Scope, id: string): Promise<Note | null> {
  const c = await scoped(s);
  const d = await c.notes.findOne({ _id: id, ...live });
  return d ? (await hydrate(c, [d]))[0] : null;
}

/** Note plus its editor blocks (for the editor) and a per-block outline (for Claude). */
export async function getNoteWithBlocks(s: Scope, id: string, opts: { outline?: boolean } = {}) {
  const c = await scoped(s);
  const d = await c.notes.findOne({ _id: id, ...live });
  if (!d) return null;
  const [note] = await hydrate(c, [d]);
  const blocks = await noteBlocks(d);
  return { note, blocks, ...(opts.outline ? { outline: await blockOutline(blocks) } : {}) };
}

export async function getTaskNoteId(s: Scope, key: string | number): Promise<string | null> {
  const c = await scoped(s);
  const t = await taskIdFor(c, key);
  return (await c.notes.findOne({ taskId: t._id, ...live }, { projection: { _id: 1 } }))?._id ?? null;
}

export type NoteFilter = {
  project?: string;
  /** A shelf of the project notes, or 'archive' for the archived ones. */
  shelf?: Shelf | 'archive';
  state?: 'active' | 'archived' | 'all';
  kind?: 'task' | 'project' | 'all';
  q?: string;
  limit?: number;
};

export async function listNotes(s: Scope, f: NoteFilter = {}): Promise<{ total: number; notes: Note[] }> {
  const c = await scoped(s);
  const q: Filter<NoteDoc> = { ...live };
  if (f.kind === 'task') q.taskId = { $ne: null };
  if (f.kind === 'project') q.taskId = null;
  if (f.q?.trim()) {
    const re = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ title: re }, { body: re }];
  }
  // Lists never need a whole page: keep a prefix of the text (for the first line) and the full length.
  const docs = (await c.notes
    .find(q, { projection: { title: 1, parentId: 1, taskId: 1, projectId: 1, archived: 1, createdBy: 1, createdAt: 1, updatedBy: 1, updatedAt: 1, deletedAt: 1, shelf: 1, orders: 1, visibility: 1, 'handover.by': 1, body: { $substrCP: ['$body', 0, 500] }, _chars: { $strLenCP: '$body' } } })
    .sort({ updatedAt: -1 })
    .toArray()) as ListedNoteDoc[];
  let notes = await hydrate(c, docs);
  if (f.project) {
    const p = await resolveProject(c, s, f.project, { create: false });
    notes = p ? notes.filter(n => n.projectId === p._id) : [];
  }
  if (f.shelf) {
    // Shelves hold top-level project notes: Archive is the archived ones, a shelf the active ones that sit on it.
    notes = notes.filter(n => n.projectId && !n.taskId && !n.parentId && (f.shelf === 'archive' ? n.archived : !n.archived && n.shelf === f.shelf));
    return { total: notes.length, notes: f.limit ? notes.slice(0, f.limit) : notes };
  }
  const state = f.state ?? 'active';
  if (state !== 'all') notes = notes.filter(n => n.archived === (state === 'archived'));
  return { total: notes.length, notes: f.limit ? notes.slice(0, f.limit) : notes };
}

/** Compact index of top-level notes per task id and per project id, for embedding in reads. */
export async function noteIndex(s: Scope, opts: { taskIds?: string[]; projectIds?: string[] }): Promise<{ byTask: Map<string, NoteRef>; byProject: Map<string, NoteRef[]> }> {
  const c = await scoped(s);
  const or: Filter<NoteDoc>[] = [];
  if (opts.taskIds?.length) or.push({ taskId: { $in: opts.taskIds } });
  if (opts.projectIds?.length) or.push({ projectId: { $in: opts.projectIds }, taskId: null, parentId: { $in: [null, undefined] } });
  const byTask = new Map<string, NoteRef>();
  const byProject = new Map<string, NoteRef[]>();
  if (!or.length) return { byTask, byProject };
  // Only what noteRef needs: the first blocks (for the first line), a prefix of the text, the full length.
  const docs = (await c.notes
    .find({ ...live, $or: or }, { projection: { title: 1, taskId: 1, projectId: 1, parentId: 1, updatedAt: 1, updatedBy: 1, createdBy: 1, shelf: 1, orders: 1, 'handover.by': 1, blocks: { $slice: 8 }, body: { $substrCP: ['$body', 0, 500] }, _chars: { $strLenCP: '$body' } } })
    .sort({ updatedAt: -1 })
    .toArray()) as ListedNoteDoc[];
  for (const d of docs) {
    if (d.taskId) byTask.set(d.taskId, noteRef(d));
    else if (d.projectId) byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), noteRef(d)]);
  }
  return { byTask, byProject };
}

/** Which of these tasks have a live note (ids only; no content read). */
export async function taskIdsWithNotes(s: Scope, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const c = await scoped(s);
  const docs = await c.notes.find({ ...live, taskId: { $in: taskIds } }, { projection: { taskId: 1 } }).toArray();
  return new Set(docs.map(d => d.taskId!));
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
  /** Internal (never in an MCP schema): skip the duplicate-title check (end_work's handovers keep their own per-writer rule). */
  allowSameTitle?: boolean;
  /** A project note's shelf (null puts it back on the default one). Not for a task's note or a sub-page; Handovers only from end_work. */
  shelf?: Shelf | null;
  /** Internal: set by end_work's handover write, the only way a note gets onto Handovers. */
  fromHandover?: boolean;
  /** Internal: on a rename into a duplicate title, 'keep' saves the rest and keeps the old title (the editor's autosave); default 'refuse'. */
  titleClash?: 'refuse' | 'keep';
  /** Sub-page only: false when the caller (the editor) inserts the page block itself. Default true. */
  linkInParent?: boolean;
  /** Optimistic concurrency: refuse if the note changed since this version (ISO updatedAt). */
  expectUpdatedAt?: string;
  /** An Orders page only: why it changed (shown beside the version), and which session and label made it. */
  why?: string;
  session?: string;
  label?: string;
  /** An Orders page only: the Need whose Accept made this change, or the version this change undoes. */
  need?: number;
  undoOf?: number;
};

/** A second note with the same title beside an existing one (H14): refused with the existing note's id. */
export class DuplicateTitleError extends InputError {
  constructor(
    message: string,
    public existing: { id: string; title: string; archived: boolean },
  ) {
    super(message);
    this.name = 'DuplicateTitleError';
  }
}

type Sibling = { id: string; title: string; archived: boolean; updatedAt: Date; shelf?: Shelf };

/**
 * The sibling that already has this title (top-level notes of one project, or the sub-pages of one page), or null. Read
 * through the caller's scope, so it can only name a note the caller can read. Archived siblings count, trashed ones don't;
 * a task's note, a handover, an Orders page and "Untitled" are not compared. No unique index: two simultaneous creates can
 * both pass (Declutter lists notes with matching titles, by titleKey).
 */
async function sameTitle(c: Collections, at: { projectId: string | null; parentId: string | null }, title: string, excludeId?: string): Promise<Sibling | null> {
  const key = titleKey(title);
  if (!key || key === titleKey(UNTITLED)) return null;
  if (!at.parentId && !at.projectId) return null;
  const sibs = await c.notes
    .find(
      { ...live, taskId: null, ...(at.parentId ? { parentId: at.parentId } : { parentId: null, projectId: at.projectId }), handover: { $exists: false }, orders: { $exists: false } },
      { projection: { title: 1, archived: 1, updatedAt: 1, shelf: 1 } },
    )
    .toArray();
  const hit = sibs.find(n => n._id !== excludeId && titleKey(n.title) === key);
  return hit ? { id: hit._id, title: hit.title, archived: !!hit.archived, updatedAt: hit.updatedAt, ...(at.parentId ? {} : { shelf: shelfOf({ shelf: hit.shelf })! }) } : null;
}

function dupMessage(d: Sibling, where: string): string {
  return `A note titled "${d.title}" is already in ${where} (note_id ${d.id}, ${d.archived ? 'archived, ' : d.shelf ? shelfLabel(d.shelf) + ', ' : ''}edited ${d.updatedAt.toISOString().slice(0, 10)}): write to it with note_id${d.archived ? ' (archived:false brings it back)' : ''}, or give another title. Nothing was saved.`;
}

async function whereIs(c: Collections, projectId: string | null, parentId: string | null): Promise<string> {
  if (parentId || !projectId) return 'this page';
  return (await c.projects.findOne({ _id: projectId }, { projection: { name: 1 } }))?.name ?? 'this project';
}

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
    // Plain text in, plain text out: only the touched text runs change, so every format on the block stays.
    if (!hasMarkdown(e.replace)) {
      const r = editInPlace(out, e.find, e.replace);
      if (r.count === 1 && r.apply) {
        r.apply();
        continue;
      }
    }
    const outline = await blockOutline(out);
    // Exact text first; only when nothing matches, the folded match (quotes, dashes, list numbers, padding, escapes).
    let per = outline.map(x => locateExact(x.markdown, e.find));
    if (!per.some(h => h.length)) per = outline.map(x => locateFolded(x.markdown, e.find));
    const count = per.reduce((n, h) => n + h.length, 0);
    const quoted = `"${e.find.slice(0, 60)}"`;
    if (count > 1) throw new InputError(`Edit text occurs ${count} times: ${quoted}. Add words around it so it is unique, or use block_ops.`);
    if (!count) {
      const page = await blocksToMarkdown(out);
      if (locate(page, e.find).length) throw new InputError(`Edit text spans two blocks: use one edit per block, or block_ops. ${quoted}`);
      throw new InputError(`Edit text not found: ${quoted}. edits match the blocks' markdown in read_note (blocks[].markdown); read the note again.`);
    }
    const i = per.findIndex(h => h.length);
    const hit = per[i][0];
    const md = outline[i].markdown;
    const loc = findBlock(out, outline[i].id)!;
    const nb = await markdownToBlocks(md.slice(0, hit.start) + e.replace.replace(/^(\s*)- /gm, '$1* ') + md.slice(hit.end));
    if (nb.length) nb[0] = { ...nb[0], id: outline[i].id } as NoteBlock;
    loc.list.splice(loc.index, 1, ...nb);
  }
  return w.blockOps?.length || w.edits?.length ? out : null;
}

function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * A dispatcher's boilerplate note is read by every session it starts, so only the person whose dispatcher reads it may
 * change, move or delete it (or add a sub-page to it), in the app: not their Claude, Discord or anyone else.
 */
/** The task a note belongs to: its own taskId, or its root page's (a sub-page of a task's note is part of that note). */
async function rootTaskId(c: Collections, n: Pick<NoteDoc, 'taskId' | 'parentId'>): Promise<string | null> {
  let cur: Pick<NoteDoc, 'taskId' | 'parentId'> | null = n;
  for (let i = 0; i < 12 && cur; i++) {
    if (cur.taskId) return cur.taskId;
    if (!cur.parentId) return null;
    cur = await c.notes.findOne({ _id: cur.parentId }, { projection: { taskId: 1, parentId: 1 } });
  }
  return null;
}

/**
 * A task's note (with its sub-pages) is part of what Claude reads for that task: someone else's change, delete or
 * restore takes it back from Claude. Called before the write (dispatcher.ts takeBackOnEdit says why).
 */
async function takeBackTaskOnNoteEdit(s: Scope, c: Collections, note: Pick<NoteDoc, 'taskId' | 'parentId'>, actor: Actor): Promise<void> {
  const taskId = await rootTaskId(c, note);
  if (!taskId) return;
  const t = await c.tasks.findOne({ _id: taskId });
  if (!t?.claude) return;
  const { takeBackOnEdit } = await import('./dispatcher');
  await takeBackOnEdit(s, t, actor);
}

async function guardBoilerplate(s: Scope, actor: Actor, ids: (string | null | undefined)[]): Promise<void> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return;
  // Locked for the note's owner only, when it is their own boilerplate (a boilerplate must be the chooser's own note,
  // dispatcher.ts ownNote): someone choosing a note they do not own locks nothing.
  const notes = await (await scoped(s)).notes.find({ _id: { $in: list } }, { projection: { ownerId: 1 } }).toArray();
  for (const n of notes) {
    const chosen = await usersWithSetting(s.orgId, 'dispatcher', { userId: n.ownerId, boilerplateNoteId: n._id });
    if (chosen.length && !(isPerson(actor) && actor.userId === n.ownerId)) throw new InputError("This note is the one a dispatcher's sessions read first; only the person who chose it can change it, in the app");
  }
}

/**
 * A note that carries Orders (lib/data/orders.ts) steers every AI that starts work. Its text (and title) may be changed by
 * the person who holds that layer, in the app, and by that person's own Claude (an agent acting for the same user, through
 * any of their keys); every such change keeps a version with undo. Everything else about it (the trash, restore, purge,
 * archive, moving, adding a sub-page) stays with that person in the app; Discord, a teammate's keys and anyone else
 * are refused. (The flag itself is set in the app only.) A teammate's Claude files propose_order instead.
 */
async function guardOrders(s: Scope, actor: Actor, ids: (string | null | undefined)[], op: 'content' | 'other' = 'other', session?: string): Promise<void> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return;
  const flagged = await (await scoped(s)).notes.find({ _id: { $in: list }, orders: { $exists: true } }, { projection: { orders: 1, ownerId: 1, projectId: 1 } }).toArray();
  for (const n of flagged) {
    const own = isPerson(actor) || (op === 'content' && actor.kind === 'agent' && actor.userId === s.userId);
    if (!own) throw new InputError('This page holds Orders; only the person who holds that layer, or their own Claude, can change its text; a teammate can have their Claude propose a change with propose_order. Trash, restore, archive and moving stay in the app.');
    if (!(await canEditOrders(s, n))) throw new InputError('This page holds Orders; only the person who holds that layer (the organization owner, the project owner, or its own person) can change it.');
    // A Claude Code session the dispatcher started on a task (its text can come from a teammate), or any Claude Code call that
    // names no session, never edits Orders: only the holder's own interactive Claude Code or chat session does.
    if (!isPerson(actor) && actor.kind === 'agent' && actor.agent === 'claude-code') {
      if (!(await isHookedInteractive(s, session))) throw new InputError('This page holds Orders; a Claude Code session started for a task (or one that names no session) cannot change them. A dispatched run proposes nothing either: tell the person in your report what you would change. Any other session: name your own session.');
    }
  }
}
/** The dispatcher names its sessions "<Project> · worker · #<ref>" (docs/dispatcher.md). */
const DISPATCHED_LABEL = /·\s*worker\s*·\s*#\d+/i;

/**
 * Is this session one the holder's own hook started, and not the dispatcher? Every presence row of it must carry `ccSession` (Claude Code's
 * own session UUID: only the hook's start route writes it; start_work over MCP cannot), no `dispatched` mark and no worker label.
 * A row made by a bare start_work with an invented id has no ccSession and never qualifies.
 */
async function isHookedInteractive(s: Scope, session: string | undefined): Promise<boolean> {
  if (!session) return false;
  const rows = await (await scoped(s)).presence.find({ userId: s.userId, $or: [{ session }, { key: session }] }, { projection: { label: 1, ccSession: 1, dispatched: 1 } }).limit(20).toArray();
  return rows.length > 0 && rows.every(r => !!r.ccSession && !r.dispatched && !DISPATCHED_LABEL.test(r.label ?? ''));
}

/** The words of an Orders text that the Words retired (docs/HANDOVER.md section 3), for a warning. */
const retiredIn = (text: string): string[] => RETIRED.map(re => re.exec(text)?.[0]).filter((x): x is string => !!x);

/** What a shelf change may be, said before anything is written. `onto` is the note's current handover flag. */
function checkShelf(w: NoteWrite, at: { taskId?: string | null; parentId?: string | null; handover?: unknown }, actor: Actor): void {
  if (w.shelf === undefined) return;
  if (at.taskId || at.parentId) throw new InputError("A task's note and a sub-page sit with their task or page; shelf is for project notes.");
  if (w.shelf === 'handovers' && !w.fromHandover) throw new InputError('A handover is left with end_work; it is the only way a note lands on Handovers.');
  if (at.handover && actor.kind === 'agent' && !w.fromHandover) throw new InputError('A handover stays on Handovers; it is moved in the app.');
}

export async function writeNote(s: Scope, w: NoteWrite, actor: Actor): Promise<{ note: Note; created: boolean; titleRefused?: { id: string; title: string }; orders?: { layer: 'org' | 'project' | 'person'; version: number; lines: string; removed: number; added: number; warning?: string } }> {
  const c = await scoped(s);
  const now = new Date();

  let cur: NoteDoc | null = null;
  let taskId: string | null = null;
  let taskPlace: Placement | null = null;
  let parent: NoteDoc | null = null;
  if (w.noteId) {
    cur = await c.notes.findOne({ _id: w.noteId, ...live });
    if (!cur) throw new NotFoundError(`Note ${w.noteId} not found`);
  } else if (w.task !== undefined) {
    const t = await taskIdFor(c, w.task);
    taskId = t._id;
    taskPlace = placeOf(t);
    cur = await c.notes.findOne({ taskId, ...live });
    if (!cur && !w.title) w.title = t.title;
  } else if (w.parentId) {
    parent = await c.notes.findOne({ _id: w.parentId, ...live });
    if (!parent) throw new NotFoundError(`Parent note ${w.parentId} not found`);
  } else if (!w.project) {
    throw new InputError('Give note_id to update a note, task for a task’s note, parent_id for a sub-page, or project to create a project note.');
  }

  await guardBoilerplate(s, actor, [cur?._id, cur?.parentId, parent?._id]);

  // Text and title of an Orders page: its holder, and the holder's own Claude. Archiving and sub-pages: the holder in the app.
  await guardOrders(s, actor, [cur?._id], w.archived === undefined && w.shelf === undefined ? 'content' : 'other', w.session ?? (actor.kind === 'agent' ? requestContext().sid : undefined));
  await guardOrders(s, actor, [cur?.parentId, parent?._id]);
  if (cur) {
    checkShelf(w, cur, actor);
    if (w.expectUpdatedAt && cur.updatedAt.toISOString() !== w.expectUpdatedAt) throw new NoteConflictError();
    const next = await applyContent(await noteBlocks(cur), w);
    const set: Partial<NoteDoc> = { updatedAt: now, updatedBy: actor };
    if (next) {
      set.blocks = next;
      set.body = await blocksToMarkdown(next);
    }
    if (w.title?.trim() && w.title.trim() !== cur.title) set.title = w.title.trim();
    let titleRefused: { id: string; title: string } | undefined;
    if (set.title && !cur.taskId && !cur.orders && !cur.handover && !w.allowSameTitle) {
      const dup = await sameTitle(c, { projectId: cur.projectId ?? null, parentId: cur.parentId ?? null }, set.title, cur._id);
      if (dup) {
        if (w.titleClash !== 'keep') throw new DuplicateTitleError(dupMessage(dup, await whereIs(c, cur.projectId ?? null, cur.parentId ?? null)), dup);
        delete set.title;
        titleRefused = { id: dup.id, title: dup.title };
      }
    }
    if (w.archived !== undefined) set.archived = w.archived;
    const unset: Record<string, ''> = {};
    if (w.shelf) set.shelf = w.shelf;
    else if (w.shelf === null) unset.shelf = '';
    if (set.blocks || set.title) await takeBackTaskOnNoteEdit(s, c, cur, actor);
    if (set.title && cur.parentId) await renamePageBlock(c, cur.parentId, cur._id, set.title);
    if (cur.orders && actor.kind === 'agent' && !w.why?.trim()) throw new InputError("Say why in why: it shows beside the change in the Orders' versions.");
    if (cur.orders === 'org' && set.body !== undefined && actor.kind === 'agent') {
      const after = ruleLines(set.body).length;
      if (after > ORG_RULE_LINES && after > ruleLines(cur.body).length) throw new InputError(`The organisation Orders hold ${ORG_RULE_LINES} lines at most (now ${after}): take one out in the same edit (one in, one out).`);
    }
    // An Orders page keeps a version of every change of its text, in the same update as the text (lib/data/orders.ts).
    const sess = w.session ?? (actor.kind === 'agent' ? requestContext().sid : undefined);
    const lbl = w.label ?? (cur.orders && sess && actor.kind === 'agent' ? (await c.presence.findOne({ userId: actor.userId, session: sess }, { projection: { label: 1 } }))?.label : undefined);
    const ver = cur.orders && set.body !== undefined ? planVersion(cur, set.body, actor, { why: w.why, session: sess, label: lbl, need: w.need, undoOf: w.undoOf }, now) : null;
    if (ver) {
      const r = await c.notes.updateOne({ _id: cur._id, updatedAt: cur.updatedAt }, { $set: { ...set, ...ver.set }, ...(ver.push ? { $push: ver.push } : {}), ...(unset.shelf !== undefined ? { $unset: unset } : {}) } as never);
      if (!r.matchedCount) throw new NoteConflictError();
      set.ordersV = ver.v;
    } else await c.notes.updateOne({ _id: cur._id }, { $set: set, ...(unset.shelf !== undefined ? { $unset: unset } : {}) });
    if (ver) await logOrders(c, { ...cur, ...set }, actor, ver, w.why);
    else if (set.blocks || set.title) await logNote(c, { ...cur, ...set }, actor, 'note_edited', set.title !== undefined && set.title !== cur.title);
    const retired = ver ? retiredIn(ver.added.join('\n')) : [];
    const orders = ver ? { layer: cur.orders!, version: ver.v, lines: cur.orders === 'org' ? `${ruleLines(set.body!).length} of ${ORG_RULE_LINES}` : `${ruleLines(set.body!).length}`, removed: ver.nRemoved, added: ver.nAdded, ...(retired.length ? { warning: `Saved. These Orders now use ${retired.map(x => '"' + x + '"').join(', ')}, a word the Words retired: use the current word (docs/HANDOVER.md section 3).` } : {}) } : undefined;
    const view: NoteDoc = { ...cur, ...set };
    if (unset.shelf !== undefined) delete view.shelf;
    return { note: (await hydrate(c, [view]))[0], created: false, ...(titleRefused ? { titleRefused } : {}), ...(orders ? { orders } : {}) };
  }

  // Create
  if (w.edits?.length || w.blockOps?.length) throw new InputError('The note does not exist yet. Pass body instead.');
  let projectId: string | null = null;
  // A note lives where what it is attached to lives: its task, its project, or the page it is inside.
  let place: Placement;
  if (parent) {
    projectId = parent.projectId ?? (parent.taskId ? ((await c.tasks.findOne({ _id: parent.taskId }, { projection: { projectId: 1 } }))?.projectId ?? null) : null);
    place = placeOf(parent);
  } else if (!taskId) {
    const p = await resolveProject(c, s, w.project!, { create: false });
    if (!p) throw new NotFoundError(`Project "${w.project}" not found`);
    projectId = p._id;
    place = placeIn(p, s.userId);
    if (!w.title?.trim()) throw new InputError('A new project note needs a title.');
  } else {
    place = taskPlace!;
  }
  checkShelf(w, { taskId, parentId: parent?._id }, actor);
  const title = (w.title ?? UNTITLED).trim() || UNTITLED;
  if (!taskId && !w.allowSameTitle) {
    const dup = await sameTitle(c, { projectId, parentId: parent?._id ?? null }, title);
    if (dup) throw new DuplicateTitleError(dupMessage(dup, await whereIs(c, projectId, parent?._id ?? null)), dup);
  }
  const blocks = (await applyContent([], { blocks: w.blocks, body: w.body ?? w.append })) ?? [];
  const doc: NoteDoc = {
    _id: newId(),
    orgId: s.orgId,
    ...place,
    title,
    blocks,
    body: await blocksToMarkdown(blocks),
    parentId: parent?._id ?? null,
    taskId,
    projectId,
    archived: w.archived ?? false,
    ...(w.shelf ? { shelf: w.shelf } : {}),
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
    deletedAt: null,
  };
  await takeBackTaskOnNoteEdit(s, c, doc, actor);
  try {
    await c.notes.insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new InputError('That task already has a note; write to it by task or note id.');
    throw err;
  }
  if (parent && w.linkInParent !== false) await addPageBlock(c, parent, doc._id, doc.title, actor);
  await logNote(c, doc, actor, 'note_created');
  return { note: (await hydrate(c, [doc]))[0], created: true };
}

/**
 * The activity feed: a row about this note, placed like the note. A task's note (or a page inside one) carries the task,
 * so its rows move, go to the trash and come back with the task; a project's note carries the project and moves with
 * it. Edits make one row per editor per hour. A person's own Orders page makes none (nobody else may read about it).
 */
/** The feed row of one Orders version: its own row per version (never folded like a note edit), none for a person's own Orders. */
async function logOrders(c: Collections, n: NoteDoc, actor: Actor, ver: { v: number; folded: boolean; nRemoved: number; nAdded: number }, why?: string): Promise<void> {
  if (n.orders === 'person') return;
  const { logChange, actorQueryOf } = await import('./tasks');
  const text = `v${ver.v}: -${ver.nRemoved} +${ver.nAdded}${why ? ` · ${why}` : ''}`;
  // A person's autosaves folded into one version stay one row (the row shows the version's current size).
  if (ver.folded) {
    const row = await c.activity.findOne({ 'subject.id': n._id, type: 'orders_changed', note: { $regex: `^v${ver.v}:` }, ...actorQueryOf(actor) }, { sort: { at: -1 }, projection: { _id: 1 } });
    if (row) {
      await c.activity.updateOne({ _id: row._id }, { $set: { at: new Date(), note: text.slice(0, 340) } });
      return;
    }
  }
  await logChange(c, n, actor, 'orders_changed', { subject: { kind: 'note', id: n._id, title: n.title }, task: null, projectId: n.projectId, note: text });
}

async function logNote(c: Collections, n: NoteDoc, actor: Actor, type: 'note_created' | 'note_edited', renamed = false): Promise<void> {
  if (n.orders === 'person') return;
  const { logChange, actorQueryOf } = await import('./tasks');
  if (type === 'note_edited') {
    const recent = await c.activity.findOne({ 'subject.id': n._id, type: { $in: ['note_created', 'note_edited'] }, at: { $gt: new Date(Date.now() - 3_600_000) }, ...actorQueryOf(actor) }, { projection: { _id: 1 } });
    if (recent) return;
  }
  const taskId = await rootTaskId(c, n);
  const task = taskId ? await c.tasks.findOne({ _id: taskId }, { projection: { ref: 1, title: 1 } }) : null;
  // A task's page whose task cannot be found (never expected: such pages are in the trash with it) makes no row, rather than one that would not move with it.
  if (taskId && !task) return;
  // The title is the editor's own when this edit renamed it; otherwise it is labelled as its creator's (notes keep no
  // separate title author, so a title someone else renamed since is still labelled as the creator's: never unlabelled).
  const titleBy = renamed || type === 'note_created' ? undefined : (actorUserId(n.createdBy) ?? undefined);
  await logChange(c, n, actor, type, { subject: { kind: 'note', id: n._id, title: n.title }, task, projectId: task ? null : n.projectId, titleBy });
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

export async function deleteNote(s: Scope, id: string, actor: Actor, opts: { expectTitle?: string } = {}): Promise<{ title: string; subPages: number }> {
  const c = await scoped(s);
  const cur = await c.notes.findOne({ _id: id, ...live });
  if (!cur) throw new NotFoundError(`Note ${id} not found`);
  if (opts.expectTitle !== undefined && cur.title.toLowerCase().trim() !== opts.expectTitle.toLowerCase().trim()) {
    throw new InputError(`Note ${id} is "${cur.title}", not "${opts.expectTitle}". Nothing deleted.`);
  }
  await guardBoilerplate(s, actor, [cur._id, cur.parentId]);
  await guardOrders(s, actor, [cur._id, cur.parentId]);
  await takeBackTaskOnNoteEdit(s, c, cur, actor);
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

/** The sub-pages deleted in the same action as note `id` (same deletedAt), walking down from it. */
async function deletedWith(c: Collections, id: string, at: Date): Promise<string[]> {
  const out: string[] = [];
  let frontier = [id];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const kids = await c.notes.find({ parentId: { $in: frontier }, deletedAt: at }, { projection: { _id: 1 } }).toArray();
    frontier = kids.map(k => k._id);
    out.push(...frontier);
  }
  return out;
}

/** A trashed note that can be restored or purged on its own: not one that went with its task (it comes back, and goes
 * for good, with the task in the task trash) or with its parent page. */
async function trashedNote(c: Collections, id: string): Promise<NoteDoc & { deletedAt: Date }> {
  const cur = await c.notes.findOne({ _id: id, deletedAt: { $ne: null } });
  if (!cur) throw new NotFoundError(`Note ${id} is not in the trash`);
  if (await c.trash.findOne({ noteIds: id }, { projection: { _id: 1 } })) throw new InputError('This note went to the trash with its task; restore the task (Review › Trash) to bring it back.');
  if (cur.parentId && (await c.notes.findOne({ _id: cur.parentId, deletedAt: cur.deletedAt }, { projection: { _id: 1 } }))) throw new InputError('This page went to the trash with the page above it; restore or delete that page instead.');
  return cur as NoteDoc & { deletedAt: Date };
}

export async function restoreNote(s: Scope, id: string, actor: Actor): Promise<Note> {
  const c = await scoped(s);
  const cur = await trashedNote(c, id);
  await guardBoilerplate(s, actor, [cur._id, cur.parentId]);
  await guardOrders(s, actor, [cur._id, cur.parentId]);
  if (cur.taskId && (await c.notes.findOne({ taskId: cur.taskId, ...live }))) throw new InputError('That task has a newer note; restore refused.');
  await takeBackTaskOnNoteEdit(s, c, cur, actor);
  // Bring back sub-pages deleted in the same action.
  const same = [id, ...(await deletedWith(c, id, cur.deletedAt))];
  await c.notes.updateMany({ _id: { $in: same } }, { $set: { deletedAt: null }, $unset: { deletedBy: '' } });
  await c.notes.updateOne({ _id: id }, { $set: { updatedAt: new Date(), updatedBy: actor } });
  if (cur.parentId) {
    const p = await c.notes.findOne({ _id: cur.parentId, ...live });
    if (p) await addPageBlock(c, p, cur._id, cur.title, actor);
  }
  return (await getNote(s, id))!;
}

/** Notes were never purged before the note trash had a view (2026-11-14): anything deleted earlier gets a full
 * NOTE_TRASH_DAYS from then, so nobody loses an old note without having seen it in Review › Trash. */
const NOTE_TRASH_SINCE = Date.parse('2026-11-14T00:00:00Z');
const purgeAt = (deletedAt: Date) => Math.max(deletedAt.getTime(), NOTE_TRASH_SINCE) + NOTE_TRASH_DAYS * 86_400_000;

export async function purgeDeletedNotes(s: Scope): Promise<number> {
  const c = await scoped(s);
  if (Date.now() < NOTE_TRASH_SINCE + NOTE_TRASH_DAYS * 86_400_000) return 0;
  const old = { deletedAt: { $ne: null, $lt: new Date(Date.now() - NOTE_TRASH_DAYS * 86_400_000) } };
  const ids = await c.notes.distinct('_id', old);
  if (!ids.length) return 0;
  const r = await c.notes.deleteMany({ ...old, _id: { $in: ids } });
  // Their feed rows go with them (they were hidden while the notes were in the trash).
  await c.activity.deleteMany({ 'subject.kind': 'note', 'subject.id': { $in: ids } });
  return r.deletedCount;
}

export type DeletedNote = {
  id: string;
  title: string;
  projectId: string | null;
  taskId: string | null;
  deletedAt: string;
  deletedBy: Actor | null;
  /** Sub-pages deleted with it (they come back, and go for good, with it). */
  subPages: number;
  purgeOn: string;
};

/** Notes in the trash the caller can see, newest first. Sub-pages deleted with their parent are folded into it.
 * Purges notes older than NOTE_TRASH_DAYS first (like the task trash, on list). */
export async function listDeletedNotes(s: Scope): Promise<DeletedNote[]> {
  const c = await scoped(s);
  await purgeDeletedNotes(s);
  // Notes that went with a task come back with the task (task trash), so they are not listed here.
  const withTasks = (await c.trash.find({ noteIds: { $exists: true } }, { projection: { noteIds: 1 } }).toArray()).flatMap(t => t.noteIds ?? []);
  const docs = await c.notes
    .find({ deletedAt: { $ne: null }, _id: { $nin: withTasks } }, { projection: { title: 1, parentId: 1, taskId: 1, projectId: 1, deletedAt: 1, deletedBy: 1 } })
    .sort({ deletedAt: -1 })
    .limit(500)
    .toArray();
  const at = new Map(docs.map(d => [d._id, d.deletedAt!.getTime()]));
  // A root is a deleted note whose parent was not deleted in the same action.
  const isRoot = (d: (typeof docs)[number]) => !d.parentId || at.get(d.parentId) !== d.deletedAt!.getTime();
  const subCount = new Map<string, number>();
  for (const d of docs) {
    if (isRoot(d)) continue;
    let p = d.parentId!;
    for (let i = 0; i < 10; i++) {
      const parent = docs.find(x => x._id === p);
      if (!parent || isRoot(parent)) break;
      p = parent.parentId!;
    }
    subCount.set(p, (subCount.get(p) ?? 0) + 1);
  }
  return docs.filter(isRoot).map(d => ({
    id: d._id,
    title: d.title || 'Untitled',
    projectId: d.projectId ?? null,
    taskId: d.taskId ?? null,
    deletedAt: d.deletedAt!.toISOString(),
    deletedBy: d.deletedBy ? asActor(d.deletedBy) : null,
    subPages: subCount.get(d._id) ?? 0,
    purgeOn: new Date(purgeAt(d.deletedAt!)).toISOString().slice(0, 10),
  }));
}

/** Delete a note in the trash for good, with the sub-pages deleted in the same action. */
export async function purgeNote(s: Scope, id: string, actor: Actor): Promise<number> {
  const c = await scoped(s);
  const cur = await trashedNote(c, id);
  const ids = [id, ...(await deletedWith(c, id, cur.deletedAt))];
  await guardBoilerplate(s, actor, [cur.parentId, ...ids]);
  await guardOrders(s, actor, [cur.parentId, ...ids]);
  const n = (await c.notes.deleteMany({ _id: { $in: ids }, deletedAt: { $ne: null } })).deletedCount;
  await c.activity.deleteMany({ 'subject.kind': 'note', 'subject.id': { $in: ids } });
  return n;
}
