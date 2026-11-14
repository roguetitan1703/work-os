import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { inTransaction, nextSeq, type NeedDoc, type NeedKind, type NeedOption, type NeedStatus, type NeedWord } from '../db';
import { orgWide, readable, scoped, type Scope, type ScopedCollections as Collections } from '../scope';
import type { Actor } from '../actors';
import { isMember } from '../people';
import { InputError, NotFoundError } from './errors';
import { placeIn, resolveProject } from './projects';

// Needs: one ask to one person (docs/flows/plan-1-3.md, slice 4; flows N1, N2, B1, B2, F2). A Need replaces "waits on
// Om" in progress text and chat. Stamped with its project's placement (the door filters each document by its own
// ownerId / visibility / sharedWith), so everyone who can read the project can read its Needs, and a project made
// private takes them along (setProjectPlacement).
//
// The trust line of this design: NO MCP tool answers a Need. The claude.ai connector also serves unattended runs, so
// it cannot prove a person is present. Answers come only from the app (answerNeed, called by the server action in
// app/(app)/needs/actions.ts), and later the addressed person's own Discord button (slice 6). The asker's word is set
// by the server from how the call came in (lib/mcp/server.ts), never from an argument.

export const NEED_LIMITS = { openPerPair: 5, ask: 500, example: 1000, answerText: 1000, optionLabel: 60, optionMeans: 300 } as const;
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
  };
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
  label?: string;
};

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
    const mine = { status: 'open' as const, 'from.actor.userId': actorId, 'from.word': input.word };
    const replaced = task ? await c.needs.find({ ...mine, taskId: task._id, kind: input.kind }).toArray() : [];
    const replacedIds = new Set(replaced.map(n => n._id));
    const open = await c.needs.find({ ...mine, to: input.to }, { projection: { _id: 1 } }).toArray();
    if (open.filter(n => !replacedIds.has(n._id)).length >= NEED_LIMITS.openPerPair) {
      throw new InputError(`You already have ${NEED_LIMITS.openPerPair} open Needs with that person. Wait for answers, or withdraw one (withdraw_need), before asking more.`);
    }

    const now = new Date();
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
      from: { actor: input.actor, word: input.word, ...(input.session ? { session: input.session.slice(0, 80) } : {}), ...(input.label ? { label: input.label.slice(0, 80) } : {}) },
      kind: input.kind,
      ask,
      ...(example ? { example } : {}),
      options,
      status: 'open',
      appOnly: input.appOnly === true || isSensitiveNeed([ask, example, ...options.flatMap(o => [o.label, o.means])]),
      createdAt: now,
      answeredAt: null,
    };
    await c.needs.insertOne(doc);
    if (replaced.length) await c.needs.updateMany({ _id: { $in: [...replacedIds] }, status: 'open' }, { $set: { status: 'replaced', closedAt: now, replacedBy: id } });
    await syncTaskNeed(c, doc.taskId);
    // One alert per Need, sent at once (like "assigned"): to the addressee, even when they asked themselves through their own agent.
    await (await orgWide(s.orgId)).alertQueue.updateOne(
      { _id: `need:${id}` },
      { $setOnInsert: { userId: input.to, kind: 'need', taskId: task?._id ?? '', byTaskId: '', needId: id, createdAt: now, sentAt: null } },
      { upsert: true },
    );
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
  return docs.map(toNeed);
}

/** One Need by its number (12, "#12") or id, if the caller can read it. */
export async function findNeed(s: Scope, key: string | number): Promise<Need | null> {
  const k = String(key).trim();
  const m = k.match(/^(?:need\s*)?#?(\d{1,9})$/i);
  const d = await (await scoped(s)).needs.findOne(m ? { ref: Number(m[1]) } : { _id: k });
  return d ? toNeed(d) : null;
}

/** One Need by id, if the caller can read it. */
export async function getNeed(s: Scope, id: string): Promise<Need | null> {
  const d = await (await scoped(s)).needs.findOne({ _id: id });
  return d ? toNeed(d) : null;
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
export async function answeredNeedsSince(s: Scope, asker: { session?: string; projectId?: string } = {}, since: Date | null = null): Promise<Need[]> {
  const q: Document = { 'from.actor.userId': s.userId, status: 'answered' };
  if (since) q.answeredAt = { $gt: since };
  if (asker.projectId) q.projectId = asker.projectId;
  if (asker.session) q.$or = [{ 'from.session': asker.session }, { 'from.session': { $exists: false } }];
  const docs = await (await scoped(s)).needs.find(q).sort({ answeredAt: 1 }).limit(50).toArray();
  return docs.map(toNeed);
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
    const now = new Date();
    const done = await c.needs.findOneAndUpdate(
      { _id: id, to: s.userId, status: 'open' },
      { $set: { status: 'answered', answer: { option: answer.option, ...(text ? { text } : {}), by: s.userId, via, at: now }, answeredAt: now, closedAt: now, waitedMs: now.getTime() - cur.createdAt.getTime() } },
      { returnDocument: 'after' },
    );
    if (!done) throw new InputError('This Need is already answered.');
    await syncTaskNeed(c, done.taskId);
    return toNeed(done);
  });
}

/** The asker takes a Need back (only the person who asked, while it is open). */
export async function withdrawNeed(s: Scope, id: string): Promise<Need> {
  return inTransaction(async () => {
    const c = await scoped(s);
    const cur = await c.needs.findOne({ _id: id, 'from.actor.userId': s.userId });
    if (!cur) throw new NotFoundError('That Need does not exist, or you did not ask it.');
    if (cur.status !== 'open') throw new InputError(`This Need is already ${cur.status}.`);
    const now = new Date();
    const done = await c.needs.findOneAndUpdate({ _id: id, 'from.actor.userId': s.userId, status: 'open' }, { $set: { status: 'withdrawn', closedAt: now } }, { returnDocument: 'after' });
    if (!done) throw new InputError('This Need is already closed.');
    await syncTaskNeed(c, done.taskId);
    return toNeed(done);
  });
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
  return docs.map(toNeed);
}
