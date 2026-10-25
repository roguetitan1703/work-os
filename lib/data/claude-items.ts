import 'server-only';
import { randomUUID } from 'node:crypto';
import { inTransaction, nextSeq, type ClaudeItemDoc } from '../db';
import { forUser, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import { requestContext } from '../request-context';
import { asActor, isAgent, isPerson, userActor } from '../actors';
import type { Actor, ClaudeItem, ClaudeItemKind, ClaudeItemState } from '../types';
import { CLAUDE_ITEM_KINDS } from '../types';
import { InputError, NotFoundError } from './errors';
import { placeIn, resolveProject, type Placement } from './projects';
import { isMember } from '../people';

/** Who an item waits on: a member of the organization who can see it (a private item waits only on its owner). */
async function waiter(s: Scope, place: Placement, who: string | undefined): Promise<string> {
  const id = who ?? s.userId;
  if (!(await isMember(s.orgId, id))) throw new InputError('waiting_on must be a member of this organization');
  if (place.visibility === 'private' && id !== place.ownerId) throw new InputError('This item is private: it can wait only on its owner');
  return id;
}

// Claude items: Claude Code's own work list, per project, kept apart from people's tasks (no
// priority, due date or alerts; never in Today, the board, stats or Discord).
//
// Rules enforced here (not just described to Claude):
//   - Clear on its own: a title of a few real words, a "why" that says what and where, and
//     (except ideas) a "done when". Vague references ("as discussed", "see above") are refused.
//   - Minimum size: small things become parts of the project's open "Small fixes" item.
//   - No spam: near-duplicate titles are refused; at most DAILY_CAP new items per project per day
//     from Claude Code.
//   - Claim: starting an item records the session; another session can't start it while that
//     claim is fresh (CLAIM_HOURS) unless it takes over explicitly.
//   - Claude never deletes; "dropped" is a person's.
//   - Waiting on a person (waitingOn, a user id; waitingText says what): only a person clears it, in the app.

export const DAILY_CAP = 10;
export const CLAIM_HOURS = 12;
const LOG_KEEP = 40;
const SMALL_GROUP_TITLE = 'Small fixes and checks';
/** Size limits (characters / counts) so no item can grow without bound. */
export const LIMITS = { title: 140, why: 2000, doneWhen: 1000, note: 1000, waiting: 1000, reason: 1000, part: 300, gitRef: 120, parts: 50, session: 64 } as const;

function within(field: keyof typeof LIMITS, v: string | undefined): string | undefined {
  if (v !== undefined && v.length > LIMITS[field]) throw new InputError(`${field} is too long (max ${LIMITS[field]} characters)`);
  return v;
}

/** A claim by another session that is still fresh (a person is never stopped by it). */
function heldByOther(d: ClaudeItemDoc, ctx: ItemCtx): string | null {
  if (isPerson(ctx.actor) || d.state !== 'active' || !d.claimedBy) return null;
  if (d.claimedBy.at.getTime() < Date.now() - CLAIM_HOURS * 3_600_000) return null;
  return d.claimedBy.session === sessionOf(ctx) ? null : d.claimedBy.session;
}
function assertMine(d: ClaudeItemDoc, ctx: ItemCtx): void {
  const other = heldByOther(d, ctx);
  if (other) throw new InputError(`${itemRef(d.ref)} is active in session ${other}. Pass session (your branch or worktree) if it is yours; otherwise leave it to that session.`);
}
function assertNotWaiting(d: ClaudeItemDoc, ctx: ItemCtx): void {
  if (!isPerson(ctx.actor) && d.waitingOn) throw new InputError(`${itemRef(d.ref)} is waiting on a person (${d.waitingText}); only they can answer that, in the app.`);
}

export const itemRef = (ref: number) => `C${ref}`;

export function toItem(d: ClaudeItemDoc): ClaudeItem {
  const { _id, keyId: _k, group: _g, orgId: _o, ownerId: _w, visibility: _v, ...rest } = d;
  return {
    ...rest,
    id: _id,
    waitingOn: d.waitingOn ?? null,
    waitingText: d.waitingText ?? '',
    createdBy: asActor(d.createdBy),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    doneAt: d.doneAt?.toISOString() ?? null,
    claimedBy: d.claimedBy ? { session: d.claimedBy.session, at: d.claimedBy.at.toISOString() } : null,
    log: d.log.map(l => ({ ...l, actor: asActor(l.actor), at: l.at.toISOString() })),
  };
}

// ── Clarity rules ───────────────────────────────────────────────────────────

const VAGUE = /\b(as discussed|see above|mentioned (above|earlier|before)|like before|the thing|that thing|same as before|etc\.?$|stuff|misc)\b/i;
const PRONOUN_START = /^(this|that|it|they|those|these|same|also|and)\b/i;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const realWords = (s: string) => words(s).filter(w => /[a-z]{3,}/i.test(w));

/** Throws InputError explaining exactly what to fix. */
export function checkClarity(i: { title: string; why: string; doneWhen?: string; kind: ClaudeItemKind; small?: boolean }): void {
  within('title', i.title.trim());
  within('why', i.why);
  within('doneWhen', i.doneWhen);
  const problems: string[] = [];
  const title = i.title.trim();
  if (title.length < 15 || title.length > 140) problems.push('title must be 15–140 characters');
  if (realWords(title).length < 3) problems.push('title needs at least 3 real words naming the thing (e.g. "Bulk bar shows locked records as editable")');
  if (PRONOUN_START.test(title)) problems.push('title must not start with this/that/it/same: name the thing itself');
  const why = i.why.trim();
  const minWhy = i.small ? 30 : 60;
  if (why.length < minWhy) problems.push(`why must be at least ${minWhy} characters: what is wrong or wanted, and where (file, screen or module)`);
  for (const [field, v] of [['title', title], ['why', why], ['done_when', i.doneWhen ?? '']] as const) {
    if (VAGUE.test(v)) problems.push(`${field} refers to something only this chat knows ("${v.match(VAGUE)![0]}"): write it so a new session with no history understands it`);
  }
  if (i.kind !== 'idea' && !i.small && (i.doneWhen ?? '').trim().length < 20) problems.push('done_when must say how to tell it is finished (at least 20 characters), e.g. "pnpm verify passes on a clean clone"');
  if (problems.length) throw new InputError(`Claude item not clear enough: ${problems.join('; ')}.`);
}

const norm = (s: string) => new Set(realWords(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')).map(w => w.replace(/s$/, '')));
function similar(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// ── Lookups ─────────────────────────────────────────────────────────────────

function refFilter(key: string | number): Partial<ClaudeItemDoc> {
  if (typeof key === 'number') return { ref: key };
  const m = key.trim().match(/^C?(\d+)$/i);
  return m ? { ref: Number(m[1]) } : { _id: key.trim() };
}

async function findDoc(c: Collections, key: string | number): Promise<ClaudeItemDoc> {
  const d = await c.claudeItems.findOne(refFilter(key));
  if (!d) throw new NotFoundError(`Claude item ${typeof key === 'number' ? itemRef(key) : key} not found`);
  return d;
}

export async function getItem(s: Scope, key: string | number): Promise<ClaudeItem | null> {
  const c = await scoped(s);
  const d = await c.claudeItems.findOne(refFilter(key));
  return d ? toItem(d) : null;
}

export type ProjectItems = {
  items: ClaudeItem[];
  /** For blocked items: the item they wait on. */
  blockers: Map<string, Pick<ClaudeItem, 'id' | 'ref' | 'title' | 'state' | 'projectId'>>;
  pickNext: ClaudeItem | null;
  /** Open items waiting on a person. */
  waiting: number;
  doneCount: number;
};

/** Open items in order (done/dropped: the last `doneLimit`), the item a new session should take, and counts. */
export async function projectItems(s: Scope, projectId: string, opts: { doneLimit?: number } = {}): Promise<ProjectItems> {
  const c = await scoped(s);
  const [open, done, doneCount] = await Promise.all([
    c.claudeItems.find({ projectId, state: { $in: ['queued', 'active', 'blocked'] } }).sort({ order: 1 }).toArray(),
    c.claudeItems.find({ projectId, state: { $in: ['done', 'dropped'] } }).sort({ updatedAt: -1 }).limit(opts.doneLimit ?? 5).toArray(),
    c.claudeItems.countDocuments({ projectId, state: 'done' }),
  ]);
  const blockerIds = [...new Set(open.map(d => d.blockedBy).filter((x): x is string => !!x))];
  const blockers = new Map(
    (await c.claudeItems.find({ _id: { $in: blockerIds } }, { projection: { ref: 1, title: 1, state: 1, projectId: 1 } }).toArray()).map(b => [
      b._id,
      { id: b._id, ref: b.ref, title: b.title, state: b.state, projectId: b.projectId },
    ]),
  );
  const items = [...open, ...done].map(toItem);
  const free = (i: ClaudeItem) => !i.waitingOn && (!i.blockedBy || blockers.get(i.blockedBy)?.state === 'done');
  const pickNext = items.find(i => i.state === 'queued' && i.next && i.kind !== 'idea' && free(i)) ?? null;
  return { items, blockers, pickNext, waiting: open.filter(d => d.waitingOn).length, doneCount };
}

/** Projects with items waiting on the caller: projectId → count. */
export async function waitingCounts(s: Scope): Promise<Map<string, number>> {
  const c = await scoped(s);
  const r = await c.claudeItems
    .aggregate<{ _id: string; n: number }>([{ $match: { state: { $in: ['queued', 'active', 'blocked'] }, waitingOn: s.userId } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }])
    .toArray();
  return new Map(r.map(x => [x._id, x.n]));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type ItemCtx = { actor: Actor; keyId?: string; session?: string };

const sessionOf = (ctx: ItemCtx) => requestContext().session ?? ctx.session;
const logEntry = (ctx: ItemCtx, text: string) => ({ at: new Date(), actor: ctx.actor, ...(sessionOf(ctx) ? { session: sessionOf(ctx) } : {}), text });

async function update(c: Collections, d: ClaudeItemDoc, set: Partial<ClaudeItemDoc>, ctx: ItemCtx, text: string): Promise<ClaudeItemDoc> {
  const r = await c.claudeItems.findOneAndUpdate(
    { _id: d._id },
    { $set: { ...set, updatedAt: new Date() }, $push: { log: { $each: [logEntry(ctx, text)], $slice: -LOG_KEEP } } },
    { returnDocument: 'after' },
  );
  return r!;
}

async function blockerId(c: Collections, key: string | number | undefined | null, self?: string): Promise<string | null> {
  if (key == null || key === '') return null;
  const b = await findDoc(c, key);
  if (b._id === self) throw new InputError('An item cannot be blocked by itself');
  return b._id;
}

export type AddInput = {
  project: string;
  title: string;
  kind: ClaudeItemKind;
  why: string;
  doneWhen?: string;
  /** small: under ~30 minutes; added as a part of the project's "Small fixes" item instead. */
  small?: boolean;
  next?: boolean;
  blockedBy?: string | number;
  /** What the person must decide or do. */
  waitingText?: string;
  /** Who (a user id in the organization); default the caller (the key's owner). */
  waitingOn?: string;
  note?: string;
  state?: 'queued' | 'active';
};

export type AddResult = { item: ClaudeItem; grouped?: true };

export async function addItem(s: Scope, input: AddInput, ctx: ItemCtx): Promise<AddResult> {
  if (!CLAUDE_ITEM_KINDS.includes(input.kind)) throw new InputError(`kind must be one of ${CLAUDE_ITEM_KINDS.join(', ')}`);
  checkClarity({ title: input.title, why: input.why, doneWhen: input.doneWhen, kind: input.kind, small: input.small });
  within('note', input.note);
  within('waiting', input.waitingText);
  if (input.title.trim().toLowerCase() === SMALL_GROUP_TITLE.toLowerCase()) throw new InputError(`"${SMALL_GROUP_TITLE}" is reserved: add small things with small: true`);
  if (input.next && isAgent(ctx.actor, 'claude-code')) throw new InputError('next is a person\u2019s call: leave it off (they mark items next in the app)');
  const c = await scoped(s);
  const p = await resolveProject(c, s, input.project, { create: false });
  if (!p) throw new NotFoundError(`Project "${input.project}" not found (create it with add_project first)`);
  const place = placeIn(p, s.userId);
  const title = input.title.trim();

  const open = await c.claudeItems.find({ projectId: p._id, state: { $in: ['queued', 'active', 'blocked'] } }).toArray();
  const twin = open.find(o => !o.group && similar(o.title, title) >= 0.6);
  if (twin) throw new InputError(`Looks like ${itemRef(twin.ref)} "${twin.title}" already covers this. Add to it instead (op note, or part for a small extra), or make the title say how it differs.`);

  if (input.small) {
    const text = `${title}: ${input.why.trim()}`;
    within('part', text);
    let group = open.find(o => o.group);
    if (group?.parts.some(x => similar(x.text, text) >= 0.6)) throw new InputError(`${itemRef(group.ref)} already lists this.`);
    if (group && group.parts.filter(x => !x.done).length >= LIMITS.parts) throw new InputError(`${itemRef(group.ref)} already has ${LIMITS.parts} open small fixes: do some before adding more`);
    if (!group) {
      group = await insert(c, s, place, {
        projectId: p._id,
        title: SMALL_GROUP_TITLE,
        kind: 'bug',
        why: 'Small fixes and checks found while working, each under ~30 minutes, grouped here so they do not each become an item. Take several at once.',
        doneWhen: 'Every part is checked off.',
        state: 'queued',
        next: false,
        group: true,
      }, ctx, 'created to group small fixes');
    }
    const part = { id: randomUUID().slice(0, 8), text, done: false };
    const r = await c.claudeItems.findOneAndUpdate(
      { _id: group._id },
      { $push: { parts: part, log: { $each: [logEntry(ctx, `added part: ${title}`)], $slice: -LOG_KEEP } }, $set: { updatedAt: new Date(), ...(group.state === 'done' ? { state: 'queued' as const } : {}) } },
      { returnDocument: 'after' },
    );
    return { item: toItem(r!), grouped: true };
  }

  if (isAgent(ctx.actor, 'claude-code')) {
    const n = await c.claudeItems.countDocuments({ projectId: p._id, 'createdBy.kind': 'agent', 'createdBy.agent': 'claude-code', createdAt: { $gte: new Date(Date.now() - 86_400_000) }, group: { $ne: true } } as never);
    if (n >= DAILY_CAP) throw new InputError(`Claude Code already added ${n} items to ${p.name} in the last 24 hours (max ${DAILY_CAP}). Group related work into one item with parts, or add small things with small: true.`);
  }
  const blockedBy = await blockerId(c, input.blockedBy);
  const waiting = input.waitingText?.trim() ?? '';
  const state: ClaudeItemState = blockedBy || waiting ? 'blocked' : (input.state ?? 'queued');
  const d = await insert(c, s, place, {
    projectId: p._id,
    title,
    kind: input.kind,
    why: input.why.trim(),
    doneWhen: input.doneWhen?.trim() ?? '',
    note: input.note?.trim() ?? '',
    state,
    next: input.kind === 'idea' ? false : !!input.next,
    blockedBy,
    waitingOn: waiting ? await waiter(s, place, input.waitingOn) : null,
    waitingText: waiting,
    ...(state === 'active' ? { claimedBy: { session: sessionOf(ctx) ?? 'unknown', at: new Date() } } : {}),
  }, ctx, 'created');
  if (waiting) await tellWaiting(s, d, ctx);
  return { item: toItem(d) };
}

/** Claude item numbers (C12) count per organization. */
const itemCounter = (s: Scope) => `claudeItems:${s.orgId}`;

async function insert(c: Collections, s: Scope, place: Placement, f: Partial<ClaudeItemDoc> & Pick<ClaudeItemDoc, 'projectId' | 'title' | 'kind' | 'why' | 'doneWhen' | 'state' | 'next'>, ctx: ItemCtx, text: string): Promise<ClaudeItemDoc> {
  const last = await c.claudeItems.find({ projectId: f.projectId }).sort({ order: -1 }).limit(1).next();
  const now = new Date();
  const d: ClaudeItemDoc = {
    _id: randomUUID(),
    orgId: s.orgId,
    ...place,
    ref: await nextSeq(c.counters, itemCounter(s)),
    note: '',
    parts: [],
    blockedBy: null,
    waitingOn: null,
    waitingText: '',
    gitRef: '',
    claimedBy: null,
    order: (last?.order ?? 0) + 1,
    ...f,
    createdBy: ctx.actor,
    createdAt: now,
    updatedAt: now,
    doneAt: null,
    log: [logEntry(ctx, text)],
    ...(ctx.keyId ? { keyId: ctx.keyId } : {}),
  };
  await c.claudeItems.insertOne(d);
  return d;
}

/** Start (claim) an item. Refuses if another session holds a fresh claim, unless takeOver. */
export async function startItem(s: Scope, key: string | number, ctx: ItemCtx, opts: { takeOver?: boolean } = {}): Promise<ClaudeItem> {
  const session = within('session', sessionOf(ctx));
  if (!session) throw new InputError('Say which session is starting it: pass session (your branch or worktree name, e.g. "wt/debt-3")');
  const c = await scoped(s);
  const d = await findDoc(c, key);
  if (d.state === 'done' || d.state === 'dropped') throw new InputError(`${itemRef(d.ref)} is ${d.state}; add a new item if more work is needed`);
  if (d.waitingOn) throw new InputError(`${itemRef(d.ref)} is waiting on a person: ${d.waitingText}`);
  if (d.blockedBy) {
    const b = await c.claudeItems.findOne({ _id: d.blockedBy }, { projection: { ref: 1, title: 1, state: 1 } });
    if (b && b.state !== 'done') throw new InputError(`${itemRef(d.ref)} waits on ${itemRef(b.ref)} "${b.title}" (${b.state})`);
  }
  const staleBefore = new Date(Date.now() - CLAIM_HOURS * 3_600_000);
  const claimFree = opts.takeOver
    ? {}
    : { $or: [{ state: { $ne: 'active' as const } }, { claimedBy: null }, { 'claimedBy.session': session }, { 'claimedBy.at': { $lt: staleBefore } }] };
  const prev = d.claimedBy && d.claimedBy.session !== session ? ` (took over from ${d.claimedBy.session})` : '';
  const r = await c.claudeItems.findOneAndUpdate(
    { _id: d._id, state: { $nin: ['done', 'dropped'] }, ...claimFree },
    {
      $set: { state: 'active', blockedBy: null, claimedBy: { session, at: new Date() }, updatedAt: new Date() },
      $push: { log: { $each: [logEntry(ctx, `started${prev}`)], $slice: -LOG_KEEP } },
    },
    { returnDocument: 'after' },
  );
  if (!r) {
    const now = await findDoc(c, d._id);
    throw new InputError(`${itemRef(now.ref)} is already active in session ${now.claimedBy?.session} since ${now.claimedBy?.at.toISOString()}. Take another item, or pass take_over: true only if that session has ended.`);
  }
  return toItem(r);
}

export async function blockItem(s: Scope, key: string | number, f: { blockedBy?: string | number; waitingText?: string; waitingOn?: string; reason?: string }, ctx: ItemCtx): Promise<ClaudeItem> {
  const c = await scoped(s);
  const d = await findDoc(c, key);
  if (d.state === 'done' || d.state === 'dropped') throw new InputError(`${itemRef(d.ref)} is ${d.state}`);
  assertMine(d, ctx);
  within('waiting', f.waitingText);
  within('reason', f.reason);
  if (!isPerson(ctx.actor) && d.waitingOn && ((f.waitingText !== undefined && !f.waitingText.trim().startsWith(d.waitingText)) || (f.waitingOn !== undefined && f.waitingOn !== d.waitingOn))) {
    throw new InputError(`${itemRef(d.ref)} is waiting on a person (${d.waitingText}); only they can clear or change that. Add to it with note.`);
  }
  const blockedBy = f.blockedBy !== undefined ? await blockerId(c, f.blockedBy, d._id) : d.blockedBy;
  const waiting = f.waitingText?.trim() || d.waitingText;
  const waitingOn = waiting ? (f.waitingText?.trim() ? await waiter(s, d, f.waitingOn ?? d.waitingOn ?? undefined) : d.waitingOn) : null;
  if (!blockedBy && !waiting && !f.reason?.trim()) throw new InputError('Say what it is blocked on: blocked_by (an item), waiting_on_om (what a person must decide or do), or reason');
  const what = [blockedBy && blockedBy !== d.blockedBy ? `blocked by ${itemRef((await findDoc(c, blockedBy)).ref)}` : '', waiting && waiting !== d.waitingText ? `waiting on a person: ${waiting}` : '', f.reason?.trim() ?? ''].filter(Boolean).join('; ');
  const r = await update(c, d, { state: 'blocked', blockedBy, waitingOn, waitingText: waiting, claimedBy: null }, ctx, what || 'blocked');
  if (waiting && (waiting !== d.waitingText || waitingOn !== d.waitingOn)) await tellWaiting(s, r, ctx);
  return toItem(r);
}

export async function doneItem(s: Scope, key: string | number, f: { gitRef?: string; note?: string }, ctx: ItemCtx): Promise<ClaudeItem> {
  const c = await scoped(s);
  const d = await findDoc(c, key);
  if (d.state === 'done') return toItem(d);
  if (d.state === 'dropped') throw new InputError(`${itemRef(d.ref)} was dropped by a person`);
  assertNotWaiting(d, ctx);
  assertMine(d, ctx);
  within('note', f.note);
  const gitRef = within('gitRef', f.gitRef?.trim()) ?? '';
  if (isAgent(ctx.actor, 'claude-code') && d.kind !== 'idea' && !gitRef) throw new InputError('Give ref: the branch or commit where it landed (e.g. "master@1a2b3c4")');
  const r = await update(
    c,
    d,
    { state: 'done', next: false, claimedBy: null, waitingOn: null, waitingText: '', doneAt: new Date(), gitRef, ...(f.note?.trim() ? { note: appendNote(d.note, f.note) } : {}) },
    ctx,
    `done${gitRef ? ` (${gitRef})` : ''}`,
  );
  // Items that waited only on this one go back to the queue.
  const waiting = await c.claudeItems.find({ blockedBy: d._id, state: 'blocked', waitingOn: null }).toArray();
  for (const w of waiting) await update(c, w, { state: 'queued', blockedBy: null }, ctx, `unblocked: ${itemRef(d.ref)} is done`);
  return toItem(r);
}

function appendNote(cur: string, add: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${cur ? cur + '\n' : ''}${stamp}: ${add.trim()}`.slice(-4000);
}

export async function noteItem(s: Scope, key: string | number, text: string, ctx: ItemCtx): Promise<ClaudeItem> {
  if (!text.trim()) throw new InputError('Note is empty');
  within('note', text);
  const c = await scoped(s);
  const d = await findDoc(c, key);
  return toItem(await update(c, d, { note: appendNote(d.note, text) }, ctx, 'note added'));
}

/** Back to the queue (session stopping before it's done). */
export async function releaseItem(s: Scope, key: string | number, ctx: ItemCtx, reason?: string): Promise<ClaudeItem> {
  const c = await scoped(s);
  const d = await findDoc(c, key);
  if (d.state !== 'active') throw new InputError(`${itemRef(d.ref)} is not active`);
  assertMine(d, ctx);
  within('reason', reason);
  return toItem(await update(c, d, { state: 'queued', claimedBy: null, ...(reason?.trim() ? { note: appendNote(d.note, reason) } : {}) }, ctx, 'released back to the queue'));
}

export type EditInput = { title?: string; why?: string; doneWhen?: string; kind?: ClaudeItemKind };

export async function editItem(s: Scope, key: string | number, f: EditInput, ctx: ItemCtx): Promise<ClaudeItem> {
  const c = await scoped(s);
  const d = await findDoc(c, key);
  const next = { title: f.title?.trim() ?? d.title, why: f.why?.trim() ?? d.why, doneWhen: f.doneWhen?.trim() ?? d.doneWhen, kind: f.kind ?? d.kind };
  if (!isPerson(ctx.actor)) {
    if (d.group && (next.title !== d.title || next.kind !== d.kind)) throw new InputError(`${itemRef(d.ref)} groups small fixes; its title and kind stay. Edit its parts instead.`);
    if (!d.group && next.title.toLowerCase() === SMALL_GROUP_TITLE.toLowerCase()) throw new InputError(`"${SMALL_GROUP_TITLE}" is reserved`);
    if (d.next && next.kind === 'idea') throw new InputError(`${itemRef(d.ref)} is marked next by a person; it can't become an idea`);
    if (!d.group) checkClarity(next);
  }
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => next[k] !== d[k]);
  if (!changed.length) return toItem(d);
  return toItem(await update(c, d, { ...next, ...(next.kind === 'idea' ? { next: false } : {}) }, ctx, `edited ${changed.join(', ')}`));
}

export async function partsItem(s: Scope, key: string | number, f: { add?: string[]; check?: (string | number)[]; uncheck?: (string | number)[] }, ctx: ItemCtx): Promise<ClaudeItem> {
  const c = await scoped(s);
  const d = await findDoc(c, key);
  assertMine(d, ctx);
  const parts = [...d.parts];
  if (parts.length + (f.add?.length ?? 0) > LIMITS.parts) throw new InputError(`${itemRef(d.ref)} can have at most ${LIMITS.parts} parts`);
  for (const t of f.add ?? []) {
    within('part', t);
    if (t.trim().length < 15) throw new InputError(`Part "${t}" is too short: say what and where`);
    if (VAGUE.test(t)) throw new InputError(`Part "${t}" refers to something only this chat knows`);
    parts.push({ id: randomUUID().slice(0, 8), text: t.trim(), done: false });
  }
  const find = (k: string | number) => {
    const i = typeof k === 'number' ? k - 1 : parts.findIndex(p => p.id === k || p.text.toLowerCase().startsWith(String(k).toLowerCase()));
    if (i < 0 || i >= parts.length) throw new InputError(`Part ${k} not found on ${itemRef(d.ref)}`);
    return i;
  };
  for (const k of f.check ?? []) parts[find(k)] = { ...parts[find(k)], done: true };
  for (const k of f.uncheck ?? []) parts[find(k)] = { ...parts[find(k)], done: false };
  const left = parts.filter(p => !p.done).length;
  return toItem(await update(c, d, { parts }, ctx, `parts: ${parts.length - left}/${parts.length} done`));
}

// ── A person (app) ──────────────────────────────────────────────────────────

/** waitingText: set (waiting on the person who saves it) or '' (answered). */
export type OmPatch = { state?: ClaudeItemState; next?: boolean; waitingText?: string; kind?: ClaudeItemKind; title?: string; why?: string; doneWhen?: string; note?: string };

export async function omUpdate(s: Scope, key: string | number, f: OmPatch): Promise<ClaudeItem> {
  const ctx: ItemCtx = { actor: userActor(s.userId) };
  const c = await scoped(s);
  const d = await findDoc(c, key);
  const set: Partial<ClaudeItemDoc> = {};
  const said: string[] = [];
  if (f.state && f.state !== d.state) {
    set.state = f.state;
    if (f.state !== 'active') set.claimedBy = null;
    if (f.state === 'done') set.doneAt = new Date();
    if (f.state === 'queued' && d.waitingOn && f.waitingText === undefined) {
      set.waitingOn = null;
      set.waitingText = '';
    }
    said.push(`state ${d.state} → ${f.state}`);
  }
  if (f.next !== undefined && f.next !== d.next) {
    set.next = f.next;
    said.push(f.next ? 'marked next' : 'next cleared');
  }
  if (f.waitingText !== undefined && f.waitingText.trim() !== d.waitingText) {
    const text = f.waitingText.trim();
    set.waitingText = text;
    set.waitingOn = text ? (d.waitingOn ?? s.userId) : null;
    said.push(text ? `waiting on a person: ${text}` : f.note?.trim() ? 'answered' : 'closed without an answer');
    if (!text && d.waitingText) set.answer = { question: d.waitingText, text: f.note?.trim().slice(0, LIMITS.note) ?? '', by: s.userId, at: new Date().toISOString() };
    if (!text && d.state === 'blocked' && !d.blockedBy && !f.state) set.state = 'queued';
  }
  for (const k of ['kind', 'title', 'why', 'doneWhen'] as const) {
    const v = typeof f[k] === 'string' ? (f[k] as string).trim() : undefined;
    if (v !== undefined && v !== d[k]) {
      (set as Record<string, unknown>)[k] = v;
      said.push(`edited ${k}`);
    }
  }
  if ((set.kind ?? d.kind) === 'idea') set.next = false;
  // An answer is kept as the item's answer (with its question), not as a loose note.
  if (f.note?.trim() && !set.answer) {
    set.note = appendNote(d.note, f.note);
    said.push('note added');
  }
  if (!said.length) return toItem(d);
  return toItem(await update(c, d, set, ctx, said.join('; ')));
}

/** Move an item `steps` places up/down within its project's open order (one transaction), or to the top. */
export async function moveItem(s: Scope, key: string | number, dir: 'up' | 'down' | 'top', steps = 1): Promise<void> {
  await inTransaction(async () => {
    const c = await scoped(s);
    const d = await findDoc(c, key);
    const list = await c.claudeItems.find({ projectId: d.projectId, state: { $in: ['queued', 'active', 'blocked'] } }).sort({ order: 1 }).toArray();
    const i = list.findIndex(x => x._id === d._id);
    if (i < 0) return;
    const n = Math.min(Math.max(Math.trunc(steps) || 1, 1), list.length);
    const j = dir === 'top' ? 0 : Math.min(Math.max(dir === 'up' ? i - n : i + n, 0), list.length - 1);
    if (j === i) return;
    const [m] = list.splice(i, 1);
    list.splice(j, 0, m);
    await c.claudeItems.bulkWrite(list.map((x, n) => ({ updateOne: { filter: { _id: x._id }, update: { $set: { order: n + 1 } } } })));
  });
}

// ── The person it waits on gets told ───────────────────────────────────────

async function tellWaiting(s: Scope, d: ClaudeItemDoc, ctx: ItemCtx): Promise<void> {
  if (!d.waitingOn || (isPerson(ctx.actor) && ctx.actor.userId === d.waitingOn)) return;
  try {
    const { addToInbox, getNotifySettings } = await import('../notify');
    const to = forUser(s, d.waitingOn);
    if ((await getNotifySettings(to)).kinds.claude_waiting === false) return;
    await addToInbox(to, [{ kind: 'claude_waiting', title: `Claude is asking: ${itemRef(d.ref)} ${d.title}`, body: d.waitingText, url: `/projects/${d.projectId}?claude=${d.ref}` }]);
  } catch (e) {
    console.error('[claude-items] notify failed', e);
  }
}

// ── Batch from MCP ─────────────────────────────────────────────────────────

export type ItemOp =
  | ({ op: 'add' } & AddInput)
  | { op: 'start'; item: string | number; takeOver?: boolean }
  | { op: 'block'; item: string | number; blockedBy?: string | number; waitingText?: string; waitingOn?: string; reason?: string }
  | { op: 'done'; item: string | number; gitRef?: string; note?: string }
  | { op: 'note'; item: string | number; text: string }
  | { op: 'release'; item: string | number; reason?: string }
  | ({ op: 'edit'; item: string | number } & EditInput)
  | { op: 'parts'; item: string | number; add?: string[]; check?: (string | number)[]; uncheck?: (string | number)[] };

export type ItemOpResult = { i: number; op: ItemOp['op']; ref: string; title: string; state: ClaudeItemState; grouped?: true };

/** All ops apply or none do. */
export async function applyItemOps(s: Scope, ops: ItemOp[], ctx: ItemCtx): Promise<ItemOpResult[]> {
  if (!ops.length) throw new InputError('No operations given');
  if (ops.length > 30) throw new InputError('At most 30 operations per call');
  return inTransaction(async () => {
    const out: ItemOpResult[] = [];
    for (const [i, o] of ops.entries()) {
      try {
        let it: ClaudeItem;
        let grouped: true | undefined;
        switch (o.op) {
          case 'add': {
            const { op: _o, ...input } = o;
            const r = await addItem(s, input, ctx);
            it = r.item;
            grouped = r.grouped;
            break;
          }
          case 'start':
            it = await startItem(s, o.item, ctx, { takeOver: o.takeOver });
            break;
          case 'block':
            it = await blockItem(s, o.item, o, ctx);
            break;
          case 'done':
            it = await doneItem(s, o.item, o, ctx);
            break;
          case 'note':
            it = await noteItem(s, o.item, o.text, ctx);
            break;
          case 'release':
            it = await releaseItem(s, o.item, ctx, o.reason);
            break;
          case 'edit': {
            const { op: _o, item, ...f } = o;
            it = await editItem(s, item, f, ctx);
            break;
          }
          case 'parts':
            it = await partsItem(s, o.item, o, ctx);
            break;
          default:
            throw new InputError(`Unknown op "${(o as { op: string }).op}"`);
        }
        out.push({ i: i + 1, op: o.op, ref: itemRef(it.ref), title: it.title, state: it.state, ...(grouped ? { grouped } : {}) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new InputError(`Op ${i + 1} (${o.op}) failed: ${msg.replace(/\.+$/, '')}. Nothing was changed.`);
      }
    }
    return out;
  });
}
