import 'server-only';
import type { NoteDoc, OrdersVersion, ProjectDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { isPerson, userActor, type Actor } from '../actors';
import { memberNames } from '../people';
import { locate } from '../notes-match';
import { InputError, NotFoundError } from './errors';

// Orders: standing rules served to every AI that starts work on a project (docs/flows/step-1.md section 2). Three layers,
// each a note carrying the `orders` field:
//   org      the organization's rules (the "Claude Code boilerplate" note, once its owner marks it): set by an owner of the
//            organization; the note must be shared with everyone, or the people it steers could not read it
//   project  a note of the project marked as its Orders: set by the project's owner
//   person   one of the person's own notes: set by its owner, served to that person's AIs only
// The flag is set in the app only (no MCP tool sets it). The text of a note that carries it is changed by the one who
// holds that layer, in the app or through their own Claude (write_note, with a why); every change keeps a version (below)
// with undo, and every session the layer steers is told of it. The trash, restore, archive and moving stay with that person
// in the app; a teammate's agent, Discord and everyone else are refused (lib/data/notes.ts guardOrders), and a teammate's
// Claude files propose_order, which the holder accepts or declines.

export type OrdersLayer = 'org' | 'project' | 'person';
const MAX_TEXT = 20_000;
/** Version logs hold up to 20 whole earlier texts: list-like reads never load them (ordersHistory does). */
const NO_LOG = { projection: { ordersLog: 0 } } as const;

export type OrdersNote = { layer: OrdersLayer; noteId: string; title: string; text: string; truncated: boolean; createdBy: unknown; updatedBy: unknown; ownerId: string; ordersBy?: string; /** The page's Orders version (1 until its first change). */ version: number; updatedAt: Date };

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
    list.map(n => ({ layer, noteId: n._id, title: n.title, text: n.body.slice(0, MAX_TEXT), truncated: n.body.length > MAX_TEXT, createdBy: n.createdBy, updatedBy: n.updatedBy, ownerId: n.ownerId, ordersBy: n.ordersBy, version: n.ordersV ?? 1, updatedAt: n.updatedAt }));
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
  const fold = !!last && isPerson(actor) && !meta.need && !meta.undoOf && last.v === v0 && isPerson(last.by) && sameActor(last.by, actor) && !last.need && !last.undoOf && !last.delivered && now.getTime() - new Date(last.at).getTime() < FOLD_MS;
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
    log: (n.ordersLog ?? []).slice().reverse().map(v => ({ v: v.v, at: new Date(v.at).toISOString(), by: v.by, ...(v.session ? { session: v.session } : {}), ...(v.label ? { label: v.label } : {}), ...(v.why ? { why: v.why } : {}), removed: v.removed, added: v.added, ...(v.need ? { need: v.need } : {}), ...(v.undoOf ? { undoOf: v.undoOf } : {}) })),
  };
}

/**
 * Who wrote this Orders text, when it is not the reader's own say: text that its layer's holder (who set the flag) did not
 * write is information, and so are project rules the reader did not write. Used by the brief and by delivery, so both label alike.
 * `label` names an author other than the reader (undefined for the reader's own).
 */
export function ordersWrittenBy(o: Pick<OrdersNote, 'layer' | 'ordersBy' | 'createdBy' | 'updatedBy'>, names: Record<string, string>, label: (a: unknown) => string | undefined): string | undefined {
  const odd = (a: unknown) => {
    const u = (a as { userId?: string } | null)?.userId;
    return o.ordersBy && u !== o.ordersBy ? (u && names[u]) || 'another member' : undefined;
  };
  const ws = [...new Set([...(o.layer === 'project' ? [o.createdBy, o.updatedBy].map(label) : []), odd(o.createdBy), odd(o.updatedBy)].filter((x): x is string => !!x))];
  return ws.length ? ws.join('; ') : undefined;
}

/** The short form of an organization Orders text for a subagent, or '' when someone other than its holder wrote it (a subagent has no writtenBy label to show, so it gets none). */
export function shortFormForSubagent(o: Pick<OrdersNote, 'layer' | 'ordersBy' | 'createdBy' | 'updatedBy' | 'text'>): string {
  return ordersWrittenBy(o, {}, () => undefined) ? '' : shortForm(o.text);
}

export type OrdersChange = {
  noteId: string;
  layer: OrdersLayer;
  title: string;
  version: number;
  at: Date;
  by: Actor;
  session?: string;
  label?: string;
  why?: string;
  removed: string[];
  added: string[];
  undoOf?: number;
  need?: number;
  ordersBy?: string;
  ownerId: string;
};

/**
 * Versions of the Orders layers served to this reader on this project (organization, project, their own person layer:
 * the reader's own door, so another person's Orders or a project the reader cannot see never appear), newest first. A page
 * with `seen[noteId]` gives the versions above it; a page not in `seen` gives the versions made after `since`. A version made
 * by session `notSession` is left out (a session is not told of its own change).
 */
export async function ordersChangesFor(s: Scope, projectId: string, opts: { since?: Date; seen?: Record<string, number>; notSession?: string; limit?: number } = {}): Promise<OrdersChange[]> {
  const served = (await ordersFor(s, { _id: projectId })).filter(o => o.version > 1);
  if (!served.length) return [];
  const c = await scoped(s);
  const docs = await c.notes.find({ _id: { $in: served.map(o => o.noteId) } }, { projection: { ordersLog: 1 } }).toArray();
  const logs = new Map(docs.map(d => [d._id, d.ordersLog ?? []]));
  const out: OrdersChange[] = [];
  for (const o of served) {
    const base = opts.seen?.[o.noteId];
    for (const e of logs.get(o.noteId) ?? []) {
      if (base !== undefined ? e.v <= base : !!opts.since && new Date(e.at) <= opts.since) continue;
      if (opts.notSession && e.session === opts.notSession) continue;
      out.push({ noteId: o.noteId, layer: o.layer, title: o.title, version: e.v, at: new Date(e.at), by: e.by, ...(e.session ? { session: e.session } : {}), ...(e.label ? { label: e.label } : {}), ...(e.why ? { why: e.why } : {}), removed: e.removed, added: e.added, ...(e.undoOf ? { undoOf: e.undoOf } : {}), ...(e.need ? { need: e.need } : {}), ...(o.ordersBy ? { ordersBy: o.ordersBy } : {}), ownerId: o.ownerId });
    }
  }
  return out.sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, opts.limit ?? 5);
}

/**
 * Undo: writes the text before version `v` as a new version (why "undo of vN", undoOf set). The holder of the layer only, a
 * person in the app. The page must be as the person last saw it (`expectedUpdatedAt`), so a change made since is looked at first.
 * Offered on every kept version; on an older one it brings back the text from before that change (later changes stay in the list).
 */
export async function undoOrders(s: Scope, noteId: string, v: number, actor: Actor, expectedUpdatedAt?: number): Promise<{ version: number }> {
  if (!isPerson(actor)) throw new InputError('Undo is done by a person in the app. An agent writes the old text back with write_note.');
  const c = await scoped(s);
  const n = await c.notes.findOne({ _id: noteId, deletedAt: null, orders: { $exists: true } });
  if (!n?.orders) throw new NotFoundError(`Note ${noteId} not found`);
  if (!(await canEditOrders(s, n))) throw new InputError('Only the person who holds this layer can undo its changes.');
  if (expectedUpdatedAt !== undefined && n.updatedAt.getTime() !== expectedUpdatedAt) throw new InputError('This page changed since you opened it. Reload it, look at the changes, then undo.');
  const e = (n.ordersLog ?? []).find(x => x.v === v);
  if (!e) throw new InputError('That version is no longer kept (a page keeps its last 20).');
  const { writeNote } = await import('./notes');
  await writeNote(s, { noteId, body: e.before, why: `undo of v${v}`, undoOf: v, expectUpdatedAt: n.updatedAt.toISOString() }, actor);
  const after = await c.notes.findOne({ _id: noteId }, { projection: { ordersV: 1 } });
  return { version: after?.ordersV ?? (n.ordersV ?? 1) };
}

// ── propose_order ───────────────────────────────────────────────────────────
// An agent whose person does not hold a layer files a proposal: a Need to the holder (Accept or Decline), on the Needs page and
// in the digest, no phone alert. Accept writes the change as the holder, one version, with why "proposed by <name>'s Claude
// (Need #n)". The holder's own agents never propose (they write_note), and nobody proposes into a person layer.

export type ProposeInput = { project: string; layer: 'org' | 'project'; old?: string; new: string; why: string; incident?: string; repeat?: boolean };

/** Files a proposal to change an Orders layer. The Need goes to the holder; nothing changes until they Accept. */
export async function proposeOrder(s: Scope, input: ProposeInput, ctx: { actor: Actor; word: import('../db').NeedWord; session?: string; keyId?: string; label?: string }): Promise<{ need: import('./needs').Need }> {
  if (input.layer !== 'org' && input.layer !== 'project') throw new InputError('layer is org or project. Your own person Orders you change with write_note, and nobody proposes into someone else\'s.');
  const text = input.new.trim();
  if (!text || text.length > 300) throw new InputError('new is the line you propose, 1 to 300 characters.');
  const why = input.why.trim();
  if (!why || why.length > 300) throw new InputError('why is 1 to 300 characters.');
  const old = input.old?.trim() || undefined;
  if (old && old.length > 300) throw new InputError('old is at most 300 characters.');
  const incident = input.incident?.trim().slice(0, 80) || undefined;
  const c = await scoped(s);
  const { resolveProject } = await import('./projects');
  const project = await resolveProject(c, s, input.project, { create: false });
  if (!project) throw new NotFoundError(`Project "${input.project}" not found`);
  const served = (await ordersFor(s, project)).filter(o => o.layer === input.layer);
  const target = served[0];
  if (!target) throw new InputError(`There are no ${input.layer === 'org' ? 'organization' : 'project'} Orders on this project to change. Its holder marks a page as Orders in the app first.`);
  const note = await c.notes.findOne({ _id: target.noteId }, { projection: { orders: 1, ownerId: 1, projectId: 1, body: 1, ordersV: 1, ordersBy: 1 } });
  if (!note?.orders) throw new NotFoundError('Orders page not found');
  if (await canEditOrders(s, note)) throw new InputError('You hold this layer: change it with write_note (say why in why).');
  const holder = input.layer === 'org' ? note.ordersBy : (await c.projects.findOne({ _id: project._id }, { projection: { ownerId: 1 } }))?.ownerId;
  if (!holder) throw new InputError('This layer has no holder to ask.');
  if (old) {
    const hits = locate(note.body, old).length;
    if (hits !== 1) throw new InputError(`old must occur exactly once in the ${input.layer === 'org' ? 'organization' : 'project'} Orders (found ${hits}): quote the line as it is now, or leave old out to add the line.`);
  }
  const { askNeed } = await import('./needs');
  const example = `${old ? `Old: ${old}\n` : ''}New: ${text}\nWhy: ${why}${incident ? ` (${incident})` : ''}`;
  const r = await askNeed(s, {
    project: project._id,
    to: holder,
    kind: 'approve',
    ask: `Change the ${input.layer === 'org' ? 'organization' : 'project'} Orders: ${text.length > 80 ? text.slice(0, 79) + '…' : text}`,
    example,
    options: [
      { id: 'accept', label: 'Accept', means: old ? 'Put the new line in place of the old one now.' : 'Add the new line to the Orders now.' },
      { id: 'decline', label: 'Decline', means: 'Leave the Orders as they are.' },
    ],
    appOnly: true,
    noAlert: true,
    batch: 'monday', // H12: a proposal waits for the owner's Monday digest and never reaches the phone
    order: { noteId: note._id, layer: input.layer, base: note.ordersV ?? 1, ...(old ? { old } : {}), new: text, why, ...(incident ? { incident } : {}), ...(input.repeat ? { repeat: true } : {}) },
    actor: ctx.actor,
    word: ctx.word,
    session: ctx.session,
    keyId: ctx.keyId,
    label: ctx.label,
  });
  return { need: r.need };
}

/**
 * The holder answered a proposal with Accept (called by answerNeed after its transaction): the change is written as the holder
 * (a person, so no why is required of an agent; the version says "proposed by <name>'s Claude (Need #n)"). If `old` is no longer
 * found exactly once, or the holder no longer holds the layer, nothing is written and `order.applied` says why; the answer stays.
 */
export async function applyOrderAnswer(s: Scope, needId: string): Promise<void> {
  const c = await scoped(s);
  const n = await c.needs.findOne({ _id: needId });
  const o = n?.order;
  if (!n || !o || n.answer?.option !== 'accept') return;
  const record = (applied: { v: number } | { error: string }) => c.needs.updateOne({ _id: needId }, { $set: { 'order.applied': applied } });
  try {
    const note = await c.notes.findOne({ _id: o.noteId, deletedAt: null, orders: o.layer });
    if (!note) throw new InputError('The Orders page is gone, or no longer holds Orders.');
    if (!(await canEditOrders(s, note))) throw new InputError('You no longer hold that layer.');
    const names = await memberNames(s.orgId);
    const askerId = 'userId' in n.from.actor ? n.from.actor.userId : undefined;
    const who = (askerId && names[askerId]) || 'a member';
    const { writeNote } = await import('./notes');
    await writeNote(s, { noteId: o.noteId, ...(o.old ? { edits: [{ find: o.old, replace: o.new }] } : { append: o.new }), why: `proposed by ${who}'s Claude (Need #${n.ref})`.slice(0, 300), need: n.ref }, userActor(s.userId));
    const after = await c.notes.findOne({ _id: o.noteId }, { projection: { ordersV: 1 } });
    await record({ v: after?.ordersV ?? (note.ordersV ?? 1) });
  } catch (e) {
    await record({ error: (e instanceof Error ? e.message : 'Could not apply it').slice(0, 200) });
  }
}

/** A session was told of version `v` of this Orders page: further autosaves of the same person start the next version, so what they type next reaches sessions too. */
export async function markOrdersDelivered(s: Scope, noteId: string, v: number): Promise<void> {
  await (await scoped(s)).notes.updateOne({ _id: noteId, 'ordersLog.v': v }, { $set: { 'ordersLog.$[e].delivered': true } }, { arrayFilters: [{ 'e.v': v }] });
}
