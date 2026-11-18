import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { requestContext } from '../request-context';
import type { HandInResult } from '../types';
import { inTransaction, nextSeq, type NeedDoc, type TaskDoc, type NeedKind, type NeedOption, type NeedStatus, type NeedWord } from '../db';
import { orgWide, readable, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import type { Actor } from '../actors';
import { isMember } from '../people';
import { InputError, NotFoundError } from './errors';
import { placeIn, placeOf, resolveProject } from './projects';

// Needs: one ask to one person (docs/flows/plan-1-3.md, slice 4; flows N1, N2, B1, B2, F2). A Need replaces "waits on
// Om" in progress text and chat. Stamped with its project's placement (the door filters each document by its own
// ownerId / visibility / sharedWith), so everyone who can read the project can read its Needs, and a project made
// private takes them along (setProjectPlacement).
//
// The trust line of this design: NO MCP tool answers a Need. The claude.ai connector also serves unattended runs, so
// it cannot prove a person is present. Answers come only from the app (answerNeed, called by the server action in
// app/(app)/needs/actions.ts), and later the addressed person's own Discord button (slice 6). The asker's word is set
// by the server from how the call came in (lib/mcp/server.ts), never from an argument.

export const NEED_LIMITS = { openPerPair: 5, perHour: 10, replaceAlertMs: 600_000, ask: 500, example: 1000, answerText: 1000, optionLabel: 60, optionMeans: 300 } as const;
/** Words that force a Need to be answered in the app only, whatever the asker said (HANDOVER: Needs). One list, here. */
export const SENSITIVE_NEED_WORDS = ['production', 'deploy', 'payment', 'refund', 'invoice', 'money', 'password', 'credential', 'secret', 'token', 'key'] as const;
const SENSITIVE_NEED = new RegExp(`(^|[^a-z])(${SENSITIVE_NEED_WORDS.join('|')})(s|ed|ing|ments?)?($|[^a-z])|[₹$] ?[0-9]|[0-9] ?[₹$]`, 'i');
export const isSensitiveNeed = (texts: (string | undefined)[]): boolean => texts.some(t => !!t && SENSITIVE_NEED.test(t));
const REPEAT_KINDS: NeedKind[] = ['decide', 'approve', 'review', 'do', 'chase'];
export const ASK_KINDS = ['decide', 'approve', 'do', 'chase'] as const satisfies readonly NeedKind[];

export type Need = {
  id: string;
  ref: number;
  projectId: string;
  taskId: string | null;
  taskRef: number | null;
  to: string;
  from: { actor: Actor; word: NeedWord; session?: string; label?: string };
  kind: NeedKind;
  ask: string;
  example?: string;
  options: NeedOption[];
  status: NeedStatus;
  appOnly: boolean;
  answer?: { option: string; text?: string; by: string; via: 'app' | 'phone' | 'discord' | 'chat'; at: string };
  createdAt: string;
  answeredAt: string | null;
  waitedMs: number | null;
  /** A review Need: what was handed in, and (once answered with "file what is left") the numbers of the tasks made. */
  result?: HandInResult;
  filed?: number[];
};

export function toNeed(d: NeedDoc): Need {
  return {
    id: d._id,
    ref: d.ref,
    projectId: d.projectId,
    taskId: d.taskId,
    taskRef: d.taskRef,
    to: d.to,
    from: d.from,
    kind: d.kind,
    ask: d.ask,
    ...(d.example ? { example: d.example } : {}),
    options: d.options,
    status: d.status,
    appOnly: d.appOnly,
    ...(d.answer ? { answer: { ...d.answer, at: d.answer.at.toISOString() } } : {}),
    createdAt: d.createdAt.toISOString(),
    answeredAt: d.answeredAt ? d.answeredAt.toISOString() : null,
    waitedMs: d.waitedMs ?? null,
    ...(d.result ? { result: d.result } : {}),
    ...(d.filed ? { filed: d.filed } : {}),
  };
}

/**
 * An app-only Need's answer is for the addressee and the asker's person (the user the asking key belongs to). Everyone else
 * who can read the project sees that it was answered, by whom and when, never the choice or the text. Every reader below
 * goes through this, so the tool and the page agree.
 */
export function forViewer(n: Need, viewerId: string): Need {
  if (!n.appOnly || !n.answer || viewerId === n.to || ('userId' in n.from.actor && viewerId === n.from.actor.userId)) return n;
  return { ...n, answer: { ...n.answer, option: '', text: '(answer hidden)' } };
}

/** The ask as a row shows it: one line, about 90 characters. */
export function shortAsk(ask: string): string {
  const one = ask.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
}

const DEFAULT_OPTIONS: Record<NeedKind, NeedOption[]> = {
  decide: [],
  approve: [
    { id: 'yes', label: 'Yes', means: 'Go ahead.' },
    { id: 'no', label: 'No', means: 'Do not do it.' },
  ],
  do: [
    { id: 'done', label: 'Done', means: 'I did it.' },
    { id: 'cant', label: "Can't", means: "I can't do this one." },
  ],
  chase: [
    { id: 'done', label: 'Done', means: 'I chased them, or they answered.' },
    { id: 'cant', label: "Can't", means: "I can't chase this one." },
  ],
  review: [
    { id: 'accept', label: 'Accept', means: 'It is good: close the task.' },
    { id: 'send_back', label: 'Send back', means: 'It needs more work.' },
  ],
};

/** 2 to 4 options with unique short ids; the first is the recommendation. A kind with defaults needs none given. */
export function optionsFor(kind: NeedKind, given?: { id?: string; label: string; means?: string }[]): NeedOption[] {
  if (!given?.length) {
    const d = DEFAULT_OPTIONS[kind];
    if (!d.length) throw new InputError('A "decide" Need needs 2 to 4 options, each with a label and what choosing it means. The first is your recommendation.');
    return d;
  }
  if (given.length < 2 || given.length > 4) throw new InputError('A Need has 2 to 4 options.');
  const used = new Set<string>();
  return given.map((o, i) => {
    const id = (o.id?.trim() || String.fromCharCode(97 + i)).toLowerCase();
    if (!/^[a-z0-9_-]{1,24}$/.test(id)) throw new InputError(`Option id "${id}" is not allowed (letters, digits, - and _, up to 24).`);
    if (used.has(id)) throw new InputError(`Two options have the id "${id}".`);
    used.add(id);
    const label = (o.label ?? '').trim();
    if (!label) throw new InputError('Every option needs a label.');
    return { id, label: label.slice(0, NEED_LIMITS.optionLabel), means: (o.means ?? '').trim().slice(0, NEED_LIMITS.optionMeans) };
  });
}

const needCounter = (s: Scope) => `need:${s.orgId}`;

function taskFilter(key: string | number): Document {
  if (typeof key === 'number') return { ref: key };
  const m = key.trim().match(/^#?(\d{1,7})$/);
  return m ? { ref: Number(m[1]) } : { _id: key.trim() };
}

/** Keeps the task's `need` mark (what rows show) in step with its open Needs: the newest one, or none. Not a task edit. */
export async function syncTaskNeed(c: Collections, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const open = await c.needs.find({ taskId, status: 'open' }).sort({ createdAt: -1 }).limit(1).toArray();
  const n = open[0];
  if (n) await c.tasks.updateOne({ _id: taskId }, { $set: { need: { id: n._id, ref: n.ref, to: n.to, ask: shortAsk(n.ask) } } });
  else await c.tasks.updateOne({ _id: taskId, need: { $exists: true } }, { $unset: { need: '' } });
}

export type AskInput = {
  project: string;
  /** The addressee's user id (the MCP tool resolves a name, email or "me"). */
  to: string;
  kind: NeedKind;
  ask: string;
  example?: string;
  options?: { id?: string; label: string; means?: string }[];
  task?: string | number;
  appOnly?: boolean;
  /** Who asks and how the call came in: set by the server, never by an argument. */
  actor: Actor;
  word: NeedWord;
  session?: string;
  keyId?: string;
  label?: string;
};

/**
 * The activity feed: a row about this Need, placed like the Need (so its project's readers only) and moved with it
 * (setProjectPlacement by projectId, restampTaskNeeds by id). The ask is the asker's own text; an answer's text is
 * never copied, only the option chosen.
 */
async function logNeed(c: Collections, n: NeedDoc, actor: Actor, type: 'need_asked' | 'need_answered' | 'need_withdrawn', note?: string): Promise<void> {
  const { logChange } = await import('./tasks');
  const asker = 'userId' in n.from.actor && n.from.actor.userId ? n.from.actor.userId : undefined;
  await logChange(c, n, actor, type, { subject: { kind: 'need', id: n._id, ref: n.ref, title: n.ask }, projectId: n.projectId || null, ...(note ? { note, ...(asker ? { textBy: asker } : {}) } : {}) });
}

/**
 * Ask one person one thing. `to` must be able to read the project; at most 5 open Needs from one asker (same word) to
 * one person; a second open Need of the same kind on the same task from the same asker replaces the first. Queues one
 * alert (kind 'need') for the addressee in the same transaction.
 */
export async function askNeed(s: Scope, input: AskInput): Promise<{ need: Need; replaced: Need[] }> {
  const ask = input.ask.trim();
  if (!ask) throw new InputError('Say what you need, in plain words.');
  if (ask.length > NEED_LIMITS.ask) throw new InputError(`The ask is at most ${NEED_LIMITS.ask} characters.`);
  const example = input.example?.trim() || undefined;
  if (example && example.length > NEED_LIMITS.example) throw new InputError(`The example is at most ${NEED_LIMITS.example} characters.`);
  if (!REPEAT_KINDS.includes(input.kind)) throw new InputError('Unknown kind of Need.');
  const options = optionsFor(input.kind, input.options);
  const actorId = 'userId' in input.actor && input.actor.userId ? input.actor.userId : s.userId;

  return inTransaction(async () => {
    const c = await scoped(s);
    const project = await resolveProject(c, s, input.project, { create: false });
    if (!project) throw new NotFoundError(`Project "${input.project}" not found`);
    if (!(await isMember(s.orgId, input.to)) || !readable(project, input.to)) throw new InputError('That person cannot see this project, so they cannot be asked about it here. Pick someone who can, or share the project first.');
    let task: { _id: string; ref: number } | null = null;
    if (input.task !== undefined && input.task !== null && String(input.task).trim() !== '') {
      const t = await c.tasks.findOne({ ...taskFilter(input.task), projectId: project._id }, { projection: { ref: 1 } });
      if (!t) throw new NotFoundError(`Task ${typeof input.task === 'number' ? '#' + input.task : `"${input.task}"`} not found in this project`);
      task = { _id: t._id, ref: t.ref };
    }
    // The same kind on the same task from the same asker is replaced, so it is not counted against the limit.
    // (A review Need is the system's, made when an agent closes work: it counts against no limit.)
    const mine = { status: 'open' as const, 'from.actor.userId': actorId, 'from.word': input.word, kind: { $ne: 'review' as const } };
    const replaced = task ? await c.needs.find({ ...mine, taskId: task._id, kind: input.kind }).toArray() : [];
    const replacedIds = new Set(replaced.map(n => n._id));
    // The limit holds under a race because the `need:<org>` counter (nextSeq below) is the lock: two asks at once both write
    // that one document in their transactions, the second gets a write conflict, withTransaction retries it, and the retry
    // counts again and sees the first one's Need (flow-n3: six asks in parallel, exactly five land).
    const open = await c.needs.find({ ...mine, to: input.to }, { projection: { _id: 1 } }).toArray();
    if (open.filter(n => !replacedIds.has(n._id)).length >= NEED_LIMITS.openPerPair) {
      throw new InputError(`You already have ${NEED_LIMITS.openPerPair} open Needs with that person. Wait for answers, or withdraw one (withdraw_need), before asking more.`);
    }

    // The phone is not a mailbox an agent may fill: at most 10 Needs created from one asker to one person in an hour, any
    // status (ask, withdraw, ask again counts each time), and a replacement within 10 minutes of the alert it replaces sends none.
    const now = new Date();
    const recent = await c.needs.countDocuments({ 'from.actor.userId': actorId, to: input.to, kind: { $ne: 'review' }, createdAt: { $gt: new Date(now.getTime() - 3_600_000) } });
    if (recent >= NEED_LIMITS.perHour) throw new InputError(`You have already asked that person ${NEED_LIMITS.perHour} times in the last hour. Wait before asking more; they have your open ones.`);
    const lastAlert = replaced.map(n => n.alertedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const quiet = lastAlert > now.getTime() - NEED_LIMITS.replaceAlertMs;
    const id = randomUUID();
    const place = placeIn(project, s.userId);
    const doc: NeedDoc = {
      _id: id,
      orgId: s.orgId,
      ownerId: place.ownerId,
      visibility: place.visibility,
      ...(place.visibility === 'members' ? { sharedWith: place.sharedWith } : {}),
      ref: await nextSeq(c.counters, needCounter(s)),
      projectId: project._id,
      taskId: task?._id ?? null,
      taskRef: task?.ref ?? null,
      to: input.to,
      from: { actor: input.actor, word: input.word, ...(input.session ? { session: input.session.slice(0, 80) } : {}), ...(input.keyId ? { keyId: input.keyId.slice(0, 80) } : {}), ...(input.label ? { label: input.label.slice(0, 80) } : {}) },
      kind: input.kind,
      ask,
      ...(example ? { example } : {}),
      options,
      status: 'open',
      appOnly: input.appOnly === true || isSensitiveNeed([ask, example, ...options.flatMap(o => [o.label, o.means])]),
      createdAt: now,
      answeredAt: null,
      ...(quiet ? { alertedAt: new Date(lastAlert) } : { alertedAt: now }),
    };
    await c.needs.insertOne(doc);
    if (replaced.length) await c.needs.updateMany({ _id: { $in: [...replacedIds] }, status: 'open' }, { $set: { status: 'replaced', closedAt: now, replacedBy: id } });
    await syncTaskNeed(await orgWide(s.orgId), doc.taskId);
    await logNeed(c, doc, input.actor, 'need_asked');
    // One alert per Need, sent at once (like "assigned"): to the addressee, even when they asked themselves through their own agent.
    if (!quiet) {
      await (await orgWide(s.orgId)).alertQueue.updateOne(
        { _id: `need:${id}` },
        { $setOnInsert: { userId: input.to, kind: 'need', taskId: task?._id ?? '', byTaskId: '', needId: id, createdAt: now, sentAt: null } },
        { upsert: true },
      );
    }
    return { need: toNeed(doc), replaced: replaced.map(n => toNeed({ ...n, status: 'replaced', replacedBy: id })) };
  });
}

export type NeedFilter = {
  /** A project id. */
  project?: string;
  /** Addressed to this user id. */
  to?: string;
  /** Asked by this user id (any word). */
  askedBy?: string;
  /** Addressed to this person or asked by them (a person's own list). */
  involving?: string;
  status?: NeedStatus[];
  limit?: number;
};

/** The Needs the caller can read (the door), newest first. */
export async function listNeeds(s: Scope, f: NeedFilter = {}): Promise<Need[]> {
  const c = await scoped(s);
  const q: Document = {};
  if (f.project) q.projectId = f.project;
  if (f.to) q.to = f.to;
  if (f.askedBy) q['from.actor.userId'] = f.askedBy;
  if (f.involving) q.$or = [{ to: f.involving }, { 'from.actor.userId': f.involving }];
  if (f.status?.length) q.status = { $in: f.status };
  const docs = await c.needs.find(q).sort({ createdAt: -1 }).limit(f.limit ?? 200).toArray();
  return docs.map(d => forViewer(toNeed(d), s.userId));
}

/** One Need by its number (12, "#12") or id, if the caller can read it. */
export async function findNeed(s: Scope, key: string | number): Promise<Need | null> {
  const k = String(key).trim();
  const m = k.match(/^(?:need\s*)?#?(\d{1,9})$/i);
  const d = await (await scoped(s)).needs.findOne(m ? { ref: Number(m[1]) } : { _id: k });
  return d ? forViewer(toNeed(d), s.userId) : null;
}

/** One Need by id, if the caller can read it. */
export async function getNeed(s: Scope, id: string): Promise<Need | null> {
  const d = await (await scoped(s)).needs.findOne({ _id: id });
  return d ? forViewer(toNeed(d), s.userId) : null;
}

/** The caller's open Needs across every project they can read: Today's "Needs you". */
export async function openNeedsToMe(s: Scope): Promise<Need[]> {
  return listNeeds(s, { to: s.userId, status: ['open'] });
}

/** How many open Needs wait on the caller (a badge). */
export async function openNeedCount(s: Scope): Promise<number> {
  return (await scoped(s)).needs.countDocuments({ to: s.userId, status: 'open' });
}

/**
 * Hook for slice 1 (`start_work`): the open Needs on this project addressed to the caller, oldest first. Slice 1 puts
 * them under "Needs you" in the brief, after the answered ones (answeredNeedsSince).
 */
export async function needsForBrief(s: Scope, projectId: string): Promise<Need[]> {
  const docs = await (await scoped(s)).needs.find({ projectId, to: s.userId, status: 'open' }).sort({ createdAt: 1 }).limit(20).toArray();
  return docs.map(toNeed);
}

/**
 * Hook for slice 1 (`forYou` source and `start_work`): Needs the caller (or one of their sessions) asked that were
 * answered after `since`. `asker.session`, when given, narrows to Needs asked by that session id (or by a call that
 * named none). Ids, refs, options and answer text; the caller words it ("your Need #N was answered: option B").
 */
export async function answeredNeedsSince(s: Scope, asker: { session?: string; keyId?: string; projectId?: string; unbriefed?: boolean } = {}, since: Date | null = null): Promise<Need[]> {
  const q: Document = { 'from.actor.userId': s.userId, status: 'answered' };
  if (asker.unbriefed) q.briefedAt = { $exists: false };
  if (since) q.answeredAt = { $gt: since };
  if (asker.projectId) q.projectId = asker.projectId;
  // A Need goes to the session that asked. A caller with no session id gets only those asked by the same key / OAuth client
  // (on the project asked about); never another session's, never another key's.
  // The key must be the asking key in every case: a session id alone is a name any caller may pass.
  if (asker.keyId) q['from.keyId'] = asker.keyId;
  else q._id = '';
  if (asker.session) q.$or = [{ 'from.session': asker.session }, { 'from.session': { $exists: false } }];
  const docs = await (await scoped(s)).needs.find(q).sort({ answeredAt: 1 }).limit(50).toArray();
  return docs.map(toNeed);
}

/** start_work handed these answers over: the next brief leaves them out. */
export async function markBriefed(s: Scope, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await (await scoped(s)).needs.updateMany({ _id: { $in: ids }, status: 'answered', briefedAt: { $exists: false } }, { $set: { briefedAt: new Date() } });
}

/** Open Needs addressed to the caller on one project that arrived after `since` (the forYou line counts them). */
export async function newNeedsForMe(s: Scope, projectId: string, since: Date): Promise<Need[]> {
  const docs = await (await scoped(s)).needs.find({ projectId, to: s.userId, status: 'open', createdAt: { $gt: since } }).sort({ createdAt: 1 }).limit(21).toArray();
  return docs.map(toNeed);
}

/**
 * State's Next lines that point at a task (`ref`) carry `waitsOn` from the open Needs on that task: "Need #7 (Om)". The
 * line's own written waitsOn stays when there is one. Read-side only, nothing is stored; no body text, only the number
 * and who is asked.
 */
export async function withNeedWaits<T extends { next: { ref?: number; waitsOn?: string }[] }>(s: Scope, projectId: string, state: T, names: Record<string, string>): Promise<T> {
  const refs = [...new Set(state.next.map(l => l.ref).filter((r): r is number => !!r))];
  if (!refs.length) return state;
  const open = await (await scoped(s)).needs.find({ projectId, status: 'open', taskRef: { $in: refs } }).sort({ createdAt: 1 }).toArray();
  if (!open.length) return state;
  return {
    ...state,
    next: state.next.map(l => {
      const n = l.ref && !l.waitsOn ? open.find(x => x.taskRef === l.ref) : undefined;
      return n ? { ...l, waitsOn: `Need #${n.ref} (${n.to === s.userId ? 'you' : names[n.to] || 'someone'})` } : l;
    }),
  };
}

/**
 * Answer a Need: only the person it is addressed to, from the app (the server action). An option, and optional text.
 * Records who, how ('app'), when and how long it waited. Taken once, atomically: a second answer finds it closed.
 * Not found, not readable and not addressed to the caller read the same.
 */
export async function answerNeed(s: Scope, id: string, answer: { option: string; text?: string }, via: 'app' | 'phone' | 'discord' = 'app'): Promise<Need> {
  const text = answer.text?.trim() || undefined;
  if (text && text.length > NEED_LIMITS.answerText) throw new InputError(`The answer text is at most ${NEED_LIMITS.answerText} characters.`);
  return inTransaction(async () => {
    const c = await scoped(s);
    const cur = await c.needs.findOne({ _id: id, to: s.userId });
    if (!cur) throw new NotFoundError('That Need does not exist, or it is not addressed to you.');
    if (cur.status !== 'open') throw new InputError(cur.status === 'answered' ? 'This Need is already answered.' : `This Need was ${cur.status}.`);
    if (!cur.options.some(o => o.id === answer.option)) throw new InputError('Choose one of the Need\'s options.');
    if (cur.kind === 'review' && answer.option === 'send_back' && !text) throw new InputError('Say what to change: your line goes first in the next brief for the task.');
    const now = new Date();
    const done = await c.needs.findOneAndUpdate(
      { _id: id, to: s.userId, status: 'open' },
      { $set: { status: 'answered', answer: { option: answer.option, ...(text ? { text } : {}), by: s.userId, via, at: now }, answeredAt: now, closedAt: now, waitedMs: now.getTime() - cur.createdAt.getTime() } },
      { returnDocument: 'after' },
    );
    if (!done) throw new InputError('This Need is already answered.');
    await syncTaskNeed(await orgWide(s.orgId), done.taskId);
    await logNeed(c, done, via === 'discord' ? { kind: 'discord', userId: s.userId } : { kind: 'user', userId: s.userId }, 'need_answered', done.options.find(o => o.id === answer.option)?.label ?? answer.option);
    if (done.kind === 'review') return toNeed(await applyReview(s, done, answer.option, text));
    return toNeed(done);
  });
}

// ── Review (slice 5) ────────────────────────────────────────────────────────

/**
 * An agent closed a task whose work needs a person's eye: one review Need to the task's owner (Accept / Send back / Accept
 * and file what is left), stamped with the task's placement. A review still open on the task is replaced, and an alert is
 * sent unless one went out for it in the last 10 minutes. Not counted against the asker's limits: it is the system's.
 */
export async function createReviewNeed(s: Scope, t: TaskDoc, actor: Actor, result: HandInResult, closing?: 'Dropped' | 'archived'): Promise<Need> {
  return inTransaction(async () => {
    const org = await orgWide(s.orgId);
    const open = await org.needs.find({ taskId: t._id, kind: 'review', status: 'open' }).toArray();
    const now = new Date();
    const last = open.map(n => n.alertedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const quiet = last > now.getTime() - NEED_LIMITS.replaceAlertMs;
    // One agent cannot fill an owner's phone with reviews: past 10 alerted reviews an hour from one asker to one owner, the Need is made without an alert.
    const askerId = actor && 'userId' in actor && actor.userId ? actor.userId : s.userId;
    const alerted = await org.needs.countDocuments({ kind: 'review', 'from.actor.userId': askerId, to: t.ownerId, createdAt: { $gt: new Date(now.getTime() - 3_600_000) }, noAlert: { $ne: true } });
    const flood = alerted >= NEED_LIMITS.perHour;
    const id = randomUUID();
    const place = placeOf(t);
    const options = [
      { id: 'accept', label: 'Accept', means: 'It is good: close the task.' },
      { id: 'send_back', label: 'Send back', means: 'It needs more work: write what to change.' },
      ...(result.left.length ? [{ id: 'accept_file', label: 'Accept and file what is left', means: `Close the task and make ${result.left.length === 1 ? 'a task' : result.left.length + ' tasks'} from what is left.` }] : []),
    ];
    const doc: NeedDoc = {
      _id: id,
      orgId: s.orgId,
      ownerId: place.ownerId,
      visibility: place.visibility,
      ...(place.visibility === 'members' ? { sharedWith: place.sharedWith } : {}),
      ref: await nextSeq(org.counters, needCounter(s)),
      projectId: t.projectId ?? '',
      taskId: t._id,
      taskRef: t.ref,
      to: t.ownerId,
      from: { actor, word: 'agent', ...(requestContext().sid ? { session: requestContext().sid } : {}) },
      kind: 'review',
      ask: `Review #${t.ref}: ${t.title}${closing === 'Dropped' ? ' (the agent wants to drop it)' : closing === 'archived' ? ' (the agent wants to archive it)' : ''}`.slice(0, NEED_LIMITS.ask),
      ...(closing ? { closing } : {}),
      ...(flood ? { noAlert: true } : {}),
      options,
      status: 'open',
      appOnly: false,
      createdAt: now,
      answeredAt: null,
      result,
      alertedAt: quiet ? new Date(last) : now,
    };
    await org.needs.insertOne(doc);
    if (open.length) await org.needs.updateMany({ _id: { $in: open.map(n => n._id) }, status: 'open' }, { $set: { status: 'replaced', closedAt: now, replacedBy: id } });
    await logNeed(org, doc, actor, 'need_asked');
    await org.tasks.updateOne({ _id: t._id }, { $unset: { sentBack: '' } });
    await syncTaskNeed(org, t._id);
    if (!quiet && !flood) {
      await org.alertQueue.updateOne({ _id: `need:${id}` }, { $setOnInsert: { userId: t.ownerId, kind: 'need', taskId: t._id, byTaskId: '', needId: id, createdAt: now, sentAt: null } }, { upsert: true });
    }
    return toNeed(doc);
  });
}

/** A task was trashed or dropped: whatever was asked about it has nothing left to ask. */
export async function closeTaskNeeds(orgId: string, taskIds: string[], reason: string): Promise<void> {
  if (!taskIds.length) return;
  const org = await orgWide(orgId);
  await closeBySystem(org, await org.needs.find({ taskId: { $in: taskIds }, status: 'open' }).toArray(), reason);
}

/** A task was closed another way (a person did it): a review still waiting on it has nothing left to ask. */
export async function closeOpenReviews(orgId: string, taskId: string, reason: string): Promise<void> {
  const org = await orgWide(orgId);
  await closeBySystem(org, await org.needs.find({ taskId, kind: 'review', status: 'open' }).toArray(), reason);
}

/** The owner answered a review Need (inside answerNeed's transaction): the task follows the answer. */
async function applyReview(s: Scope, need: NeedDoc, option: string, text: string | undefined): Promise<NeedDoc> {
  const c = await scoped(s);
  const t = need.taskId ? await c.tasks.findOne({ _id: need.taskId }) : null;
  if (!t) return need;
  const tasks = await import('./tasks');
  const actor: Actor = { kind: 'user', userId: s.userId };
  const org = await orgWide(s.orgId);
  const now = new Date();
  if (option === 'send_back') {
    await tasks.updateTask(s, t._id, { status: 'In Progress' }, actor, { note: `Sent back: ${text}` });
    // The old evidence goes: a later close without a fresh hand_in must not reuse it.
    await org.tasks.updateOne({ _id: t._id }, { $set: { sentBack: { line: text!, by: s.userId, at: now } }, $inc: { 'review.sentBack': 1 }, $unset: { handIn: '' } });
    await (await import('./dispatcher')).requeueAfterSendBack(org, t);
    return need;
  }
  // accept, accept_file
  const outcome = (t.review?.sentBack ?? 0) > 0 ? 'accepted_after_send_back' : 'accepted_first_time';
  let filed: number[] | undefined;
  if (option === 'accept_file') {
    filed = [];
    for (const line of need.result?.left ?? []) {
      // The line is the agent's text: filed under the owner's name, but labelled as the agent's wherever it is read.
      const k = await tasks.createTask(s, { title: line.slice(0, 300), ...(t.projectId ? { project: t.projectId } : {}) }, actor, { note: `Left over from #${t.ref}`, authors: { title: need.from.actor } });
      filed.push(k.ref);
    }
    await org.needs.updateOne({ _id: need._id }, { $set: { filed } });
  }
  if (t.status === 'Dropped') return filed ? { ...need, filed } : need; // dropped meanwhile: accepting does not bring it back as Done
  if (need.closing === 'archived') await tasks.setArchived(s, t._id, true, actor);
  else if (t.status !== (need.closing ?? 'Done')) await tasks.updateTask(s, t._id, { status: need.closing ?? 'Done' }, actor, { note: option === 'accept_file' ? 'Accepted; the rest filed as tasks' : 'Accepted' });
  await org.tasks.updateOne({ _id: t._id }, { $set: { 'review.outcome': outcome, 'review.at': now }, $unset: { sentBack: '' } });
  return filed ? { ...need, filed } : need;
}

/** Who is withdrawing: the app (the person), or an MCP call with the word the server gave it and the session / key behind it. */
export type Withdrawer = 'app' | { word: NeedWord; session?: string; keyId?: string };

/**
 * The asker takes a Need back, while it is open. From the app, the person who asked. From an agent call: only a Need of the
 * same word and, where recorded, the same session and the same key / OAuth client (a session id alone is only a name); a person's own Needs
 * are taken back in the app only, and a review Need (slice 5) is never taken back by an agent. Any miss reads as "no such Need".
 */
export async function withdrawNeed(s: Scope, id: string, by: Withdrawer = 'app'): Promise<Need> {
  return inTransaction(async () => {
    const c = await scoped(s);
    const cur = await c.needs.findOne({ _id: id, 'from.actor.userId': s.userId });
    const mine =
      !!cur &&
      (by === 'app' ||
        (cur.from.word !== 'person' && cur.kind !== 'review' && cur.from.word === by.word && (!cur.from.session || cur.from.session === by.session) && (!cur.from.keyId || cur.from.keyId === by.keyId)));
    if (!cur || !mine) throw new NotFoundError('That Need does not exist, or you did not ask it.');
    if (cur.status !== 'open') throw new InputError(`This Need is already ${cur.status}.`);
    const now = new Date();
    const done = await c.needs.findOneAndUpdate({ _id: id, 'from.actor.userId': s.userId, status: 'open' }, { $set: { status: 'withdrawn', closedAt: now } }, { returnDocument: 'after' });
    if (!done) throw new InputError('This Need is already closed.');
    await syncTaskNeed(await orgWide(s.orgId), done.taskId);
    // From the app the person; through MCP the asker itself (only the same word, session and key may withdraw it).
    await logNeed(c, done, by === 'app' ? { kind: 'user', userId: s.userId } : done.from.actor, 'need_withdrawn');
    return toNeed(done);
  });
}

async function closeBySystem(c: Collections, dead: NeedDoc[], reason: string): Promise<number> {
  if (!dead.length) return 0;
  const now = new Date();
  await c.needs.updateMany({ _id: { $in: dead.map(n => n._id) }, status: 'open' }, { $set: { status: 'withdrawn', closedAt: now, withdrawnReason: reason } });
  for (const t of new Set(dead.map(n => n.taskId).filter((x): x is string => !!x))) await syncTaskNeed(c, t);
  return dead.length;
}

/**
 * Withdraws the open Needs (matching `filter`) whose addressee can no longer read them, or all of them (`everyone`: the
 * addressee left the organization), and resyncs their tasks' marks. c: the organization without the visibility rule.
 */
export async function withdrawUnreadableNeeds(c: Collections, filter: Document, reason: string, opts: { everyone?: boolean } = {}): Promise<number> {
  const open = await c.needs.find({ ...filter, status: 'open' }).toArray();
  return closeBySystem(c, opts.everyone ? open : open.filter(n => !readable(n, n.to)), reason);
}

/**
 * A task (and its subtasks) changed project or placement: its Needs take the task's new project and placement, those whose
 * addressee cannot read it there are withdrawn, and the task's `need` mark is rebuilt. Org-wide, not through the caller's door.
 */
export async function restampTaskNeeds(orgId: string, taskIds: string[]): Promise<void> {
  const c = await orgWide(orgId);
  if (!taskIds.length || !(await c.needs.findOne({ taskId: { $in: taskIds } }, { projection: { _id: 1 } }))) return;
  const tasks = await c.tasks.find({ _id: { $in: taskIds } }, { projection: { projectId: 1, ownerId: 1, visibility: 1, sharedWith: 1 } }).toArray();
  for (const t of tasks) {
    const set: Document = { ownerId: t.ownerId, visibility: t.visibility, sharedWith: t.visibility === 'members' ? (t.sharedWith ?? []) : [] };
    if (t.projectId) set.projectId = t.projectId;
    await c.needs.updateMany({ taskId: t._id }, { $set: set });
    // Their feed rows follow them: the same placement and project (rows are found by the Need, the one subject id).
    const ids = await c.needs.distinct('_id', { taskId: t._id });
    if (ids.length) await c.activity.updateMany({ 'subject.kind': 'need', 'subject.id': { $in: ids } }, { $set: set });
    await withdrawUnreadableNeeds(c, { taskId: t._id }, 'moved');
    await syncTaskNeed(c, t._id);
  }
}

/** Is this task waiting on an open Need? (The stalled alert and the digest skip such tasks.) Reads the task's own mark. */
export const waitsOnNeed = (t: { need?: unknown }): boolean => !!t.need;

/** Open Needs the caller can read on one project, for the project page (with answered ones from the last 14 days). */
export async function projectNeeds(s: Scope, projectId: string): Promise<Need[]> {
  const c = await scoped(s);
  const since = new Date(Date.now() - 14 * 86_400_000);
  const docs = await c.needs
    .find({ projectId, $or: [{ status: 'open' }, { status: { $in: ['answered', 'withdrawn', 'replaced'] }, closedAt: { $gte: since } }] })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return docs.map(d => forViewer(toNeed(d), s.userId));
}
