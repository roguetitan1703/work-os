import 'server-only';
import type { NoteDoc, OrdersVersion, ProjectDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { isPerson, type Actor } from '../actors';
import { InputError, NotFoundError } from './errors';

// Orders: standing rules served to every AI that starts work on a project (docs/flows/step-1.md section 2). Three layers,
// each a note carrying the `orders` field:
//   org      the organization's rules (the "Claude Code boilerplate" note, once its owner marks it): set by an owner of the
//            organization; the note must be shared with everyone, or the people it steers could not read it
//   project  a note of the project marked as its Orders: set by the project's owner
//   person   one of the person's own notes: set by its owner, served to that person's AIs only
// The flag is set in the app only (no MCP tool sets it), and a note that carries it is changed, moved to the trash or
// restored by a person in the app only, and only by the one who holds that layer (lib/data/notes.ts guardOrders): one
// prompt-injected agent, or one teammate, cannot rewrite the rules every agent follows.

export type OrdersLayer = 'org' | 'project' | 'person';
const MAX_TEXT = 20_000;
/** Version logs hold up to 20 whole earlier texts: list-like reads never load them (ordersHistory does). */
const NO_LOG = { projection: { ordersLog: 0 } } as const;

export type OrdersNote = { layer: OrdersLayer; noteId: string; title: string; text: string; truncated: boolean; createdBy: unknown; updatedBy: unknown; ownerId: string; ordersBy?: string };

/** The Orders in force for a person starting work on a project: organization, project, person, in that order. */
export async function ordersFor(s: Scope, project: Pick<ProjectDoc, '_id'>): Promise<OrdersNote[]> {
  const c = await scoped(s);
  const live = { deletedAt: null, archived: false };
  const [org, proj, mine] = await Promise.all([
    c.notes.find({ orders: 'org', visibility: 'org', ...live }, NO_LOG).sort({ createdAt: 1 }).limit(5).toArray(),
    c.notes.find({ orders: 'project', projectId: project._id, taskId: null, ...live }, NO_LOG).sort({ createdAt: 1 }).limit(5).toArray(),
    c.notes.find({ orders: 'person', ownerId: s.userId, ordersBy: s.userId, ...live }, NO_LOG).sort({ createdAt: 1 }).limit(5).toArray(),
  ]);
  const out = (layer: OrdersLayer, list: NoteDoc[]): OrdersNote[] =>
    list.map(n => ({ layer, noteId: n._id, title: n.title, text: n.body.slice(0, MAX_TEXT), truncated: n.body.length > MAX_TEXT, createdBy: n.createdBy, updatedBy: n.updatedBy, ownerId: n.ownerId, ordersBy: n.ordersBy }));
  return [...out('org', org), ...out('project', proj), ...out('person', mine)];
}

/** May this person change a note that carries Orders? The one who holds the layer (see the top of this file). */
export async function canEditOrders(s: Scope, note: Pick<NoteDoc, 'orders' | 'ownerId' | 'projectId'>): Promise<boolean> {
  if (note.orders === 'person') return note.ownerId === s.userId;
  if (note.orders === 'project') {
    if (!note.projectId) return false;
    const p = await (await scoped(s)).projects.findOne({ _id: note.projectId }, { projection: { ownerId: 1 } });
    return p?.ownerId === s.userId;
  }
  if (note.orders === 'org') return (await (await import('../caller')).roleOf(s.userId, s.orgId)) === 'owner';
  return true;
}

/** Marks a note as a layer of Orders, or clears it (layer null). App only: the actor must be a person. */
export async function setOrders(s: Scope, noteId: string, layer: OrdersLayer | null, actor: Actor, expectedUpdatedAt?: number): Promise<{ noteId: string; orders: OrdersLayer | null }> {
  if (!isPerson(actor)) throw new InputError('Orders are set by a person in the app only.');
  const c = await scoped(s);
  const n = await c.notes.findOne({ _id: noteId, deletedAt: null });
  if (!n) throw new NotFoundError(`Note ${noteId} not found`);
  // The switch was shown for a version of the page: if the page changed since (a teammate edited the rules after you looked), nothing is marked.
  if (expectedUpdatedAt !== undefined && n.updatedAt.getTime() !== expectedUpdatedAt) throw new InputError('This page changed since you opened it. Reload it, read it again, then mark it.');
  if (n.taskId || n.parentId) throw new InputError('Orders must be a top-level page: not a task note or a sub-page.');
  const want = layer ?? n.orders;
  if (want) {
    if (n.orders && n.orders !== want && layer) throw new InputError('This page is Orders already; clear it first.');
    const probe: Pick<NoteDoc, 'orders' | 'ownerId' | 'projectId'> = { orders: want, ownerId: n.ownerId, projectId: n.projectId };
    if (want === 'org') {
      if (!(await canEditOrders(s, probe))) throw new InputError('Only an owner of the organization can set the organization Orders.');
      if (layer && n.visibility !== 'org') throw new InputError('The organization Orders must be shared with everyone (a page in a shared project, or one that is not private).');
    } else if (want === 'project') {
      if (!n.projectId) throw new InputError('Project Orders must be a page of the project.');
      if (!(await canEditOrders(s, probe))) throw new InputError("Only the project's owner can set its Orders.");
    } else if (n.ownerId !== s.userId) throw new InputError('Your own Orders must be one of your own pages.');
  }
  await c.notes.updateOne({ _id: noteId }, layer ? { $set: { orders: layer, ordersBy: s.userId } } : { $unset: { orders: '', ordersBy: '' } });
  return { noteId, orders: layer };
}

// ── Versions ────────────────────────────────────────────────────────────────
// Every change of an Orders page's text is a version (docs/flows/agent-system.md 16.x, H9): who, when, why, the lines that
// went and came, and the whole text before it (for undo). They live on the note itself, so they move, trash and restore
// with it and are read only through the note's own door. A person's autosaves within ten minutes fold into one version.

export const ORDERS_LOG_MAX = 20;
/** The organization Orders hold this many rule lines at most (an agent's write that leaves more is refused). */
export const ORG_RULE_LINES = 40;
const FOLD_MS = 600_000;
const DIFF_LINES = 40;
const DIFF_CHARS = 300;

/** The rule lines of an Orders text: non-blank lines that are not headings. */
export function ruleLines(body: string): string[] {
  return body.split('\n').map(l => l.trim()).filter(l => l && !/^#{1,6}(\s|$)/.test(l));
}

/** The first ten rule lines (at most 1,200 characters): what a subagent starts with. */
export function shortForm(body: string): string {
  const out: string[] = [];
  let n = 0;
  for (const l of ruleLines(body).slice(0, 10)) {
    if (n + l.length + 1 > 1200) break;
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n');
}

const textLines = (t: string) => t.split('\n').map(l => l.trimEnd()).filter(l => l.trim());

/** Lines taken out and lines put in, by a longest-common-subsequence over the non-blank lines (all lines of the text). */
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = textLines(before);
  const b = textLines(after);
  let i0 = 0;
  while (i0 < a.length && i0 < b.length && a[i0] === b[i0]) i0++;
  let ea = a.length;
  let eb = b.length;
  while (ea > i0 && eb > i0 && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const x = a.slice(i0, ea);
  const y = b.slice(i0, eb);
  if (x.length * y.length > 4_000_000) {
    const sx = new Set(x), sy = new Set(y);
    return { removed: x.filter(l => !sy.has(l)), added: y.filter(l => !sx.has(l)) };
  }
  const w = y.length + 1;
  const t = new Uint16Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  while (i < x.length) removed.push(x[i++]);
  while (j < y.length) added.push(y[j++]);
  return { removed, added };
}

const keep = (lines: string[]) => lines.slice(0, DIFF_LINES).map(l => (l.length > DIFF_CHARS ? l.slice(0, DIFF_CHARS - 1) + '…' : l));
const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && (a as { userId?: string }).userId === (b as { userId?: string }).userId && (a as { agent?: string }).agent === (b as { agent?: string }).agent;

export type VersionMeta = { why?: string; session?: string; label?: string; need?: number; undoOf?: number };
export type VersionPlan = {
  /** The version number the page has after this write. */
  v: number;
  folded: boolean;
  /** Fields for the same updateOne as the content ($set), and an entry to $push when a new version starts. */
  set: Record<string, unknown>;
  push?: { ordersLog: { $each: OrdersVersion[]; $slice: number } };
  removed: string[];
  added: string[];
  nRemoved: number;
  nAdded: number;
};

/**
 * What a write of `next` over an Orders page makes of its versions, or null when the text did not change. Done inside
 * writeNote (lib/data/notes.ts) so the text and its version are one update, guarded by the page's updatedAt: two writers
 * cannot both take v14.
 */
export function planVersion(cur: Pick<NoteDoc, 'body' | 'ordersV' | 'ordersLog'>, next: string, actor: Actor, meta: VersionMeta, now: Date): VersionPlan | null {
  if (next === cur.body) return null;
  const log = cur.ordersLog ?? [];
  const last = log[log.length - 1];
  const v0 = cur.ordersV ?? 1;
  const fold = !!last && isPerson(actor) && !meta.need && !meta.undoOf && last.v === v0 && isPerson(last.by) && sameActor(last.by, actor) && !last.need && !last.undoOf && now.getTime() - new Date(last.at).getTime() < FOLD_MS;
  const base = fold ? last.before : cur.body;
  const d = lineDiff(base, next);
  if (fold) {
    const k = `ordersLog.${log.length - 1}`;
    return { v: v0, folded: true, set: { [`${k}.at`]: now, [`${k}.removed`]: keep(d.removed), [`${k}.added`]: keep(d.added), ...(meta.why ? { [`${k}.why`]: meta.why } : {}) }, removed: keep(d.removed), added: keep(d.added), nRemoved: d.removed.length, nAdded: d.added.length };
  }
  const entry: OrdersVersion = {
    v: v0 + 1,
    at: now,
    by: actor,
    ...(meta.session ? { session: meta.session } : {}),
    ...(meta.label ? { label: meta.label.slice(0, 120) } : {}),
    ...(meta.why ? { why: meta.why.slice(0, 300) } : {}),
    before: cur.body.slice(0, MAX_TEXT),
    removed: keep(d.removed),
    added: keep(d.added),
    ...(meta.need ? { need: meta.need } : {}),
    ...(meta.undoOf ? { undoOf: meta.undoOf } : {}),
  };
  return { v: v0 + 1, folded: false, set: { ordersV: v0 + 1 }, push: { ordersLog: { $each: [entry], $slice: -ORDERS_LOG_MAX } }, removed: entry.removed, added: entry.added, nRemoved: d.removed.length, nAdded: d.added.length };
}

export type OrdersHistory = {
  noteId: string;
  title: string;
  layer: OrdersLayer;
  version: number;
  updatedAt: string;
  canEdit: boolean;
  log: { v: number; at: string; by: Actor; session?: string; label?: string; why?: string; removed: string[]; added: string[]; need?: number; undoOf?: number }[];
};

/** The versions of an Orders page the reader can read (newest first), or null: not Orders, not theirs, not found. */
export async function ordersHistory(s: Scope, noteId: string): Promise<OrdersHistory | null> {
  const c = await scoped(s);
  const n = await c.notes.findOne({ _id: noteId, deletedAt: null, orders: { $exists: true } });
  if (!n?.orders) return null;
  if (n.orders === 'person' && n.ownerId !== s.userId) return null;
  return {
    noteId: n._id,
    title: n.title,
    layer: n.orders,
    version: n.ordersV ?? 1,
    updatedAt: n.updatedAt.toISOString(),
    canEdit: await canEditOrders(s, n),
    log: (n.ordersLog ?? []).slice().reverse().map(({ before: _before, at, ...v }) => ({ ...v, at: new Date(at).toISOString() })),
  };
}
