import 'server-only';
import { requestContext } from '../request-context';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { inTransaction, type ProjectDoc, type StateDoc, type StateLine } from '../db';
import { scoped, type Scope } from '../scope';
import { isPerson, userActor, type Actor } from '../actors';
import { InputError, NotFoundError } from './errors';
import { placeIn, resolveProject } from './projects';
import { completeTask, createTask, getTask, logChange } from './tasks';
import type { Priority } from '../types';

// The project's State (docs/flows/step-1.md section 1): Now (one goal), Next (ordered), Later (one line each, with what it
// waits on), Decisions (append-only), Where (per machine) and a version bumped on every write. One document per project
// (`_id` = the project id) stamped with the project's placement, so the door shows it to the project's readers only
// (and lib/data/projects.ts setProjectPlacement moves it with the project).
//
// Writes: set_now needs base_version (the version the writer read); if it is stale nothing is written and the current State
// comes back. Every other op names its line (id or find) and is checked per line: the text or id must still be there. Appends (add_next, add_later, add_decision) and set_where are $push / $set
// on their own field, so two sessions' appends both land. The whole call is one transaction: of two calls that meet,
// one is retried by the driver.

export const LIMITS = { line: 500, now: 1000, decision: 1000, next: 100, later: 300, decisions: 500 } as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const waits = z.string().trim().min(1).max(200).optional();
const lineId = z.string().trim().min(1).max(40).optional();
// `find`: text inside exactly one line (case-sensitive substring), in place of `id`.
const findText = z.string().min(1).max(LIMITS.line).optional();

export const StateOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_now'), text: text(LIMITS.now), holder: z.string().trim().max(120).optional() }),
  z.object({ op: z.literal('add_next'), text: text(LIMITS.line), ref: z.number().int().min(1).max(10_000_000).optional(), waits_on: waits }),
  z.object({ op: z.literal('move_next'), id: lineId, find: findText, to: z.union([z.literal('top'), z.literal('bottom'), z.number().int().min(1).max(LIMITS.next)]) }),
  z.object({ op: z.literal('done_next'), id: lineId, find: findText }),
  z.object({ op: z.literal('add_later'), text: text(LIMITS.line), waits_on: waits }),
  z.object({ op: z.literal('promote_later'), id: lineId, find: findText, priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional() }),
  z.object({ op: z.literal('add_decision'), text: text(LIMITS.decision) }),
  // Takes a decision off the State's list (it stays in the log): the project's owner or an owner of the organization only.
  z.object({ op: z.literal('archive_decision'), id: lineId, find: findText }),
  // Replaces `find` with `new` inside the one Now, Next or Later line that holds it. An empty `new` removes the line
  // (Next: done, Later: dropped; both stay in the history). The edited line becomes the caller's.
  // `id` (optional) narrows the search to that Next or Later line, which must hold `find`.
  z.object({ op: z.literal('edit_line'), find: z.string().min(1).max(LIMITS.line), new: z.string().max(LIMITS.line), id: lineId }),
  z.object({
    op: z.literal('set_where'),
    machine: z.string().trim().min(1).max(40),
    branch: z.string().trim().max(200).optional(),
    head: z.string().trim().max(80).optional(),
    dirty: z.boolean().optional(),
    worktrees: z.array(z.string().trim().max(200)).max(20).optional(),
  }),
]);
export type StateOp = z.infer<typeof StateOpSchema>;
export const StateOpsSchema = z.array(StateOpSchema).min(1).max(30);
/** The ops that need base_version: set_now overwrites what a teammate may have just changed. The others are checked per line. */
const VERSIONED = new Set(['set_now']);

export type Via = 'chat' | 'code' | 'app' | 'discord';

const lid = () => `l_${randomBytes(4).toString('hex')}`;
const machineKey = (m: string) => m.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'machine';

export async function getState(s: Scope, key: string): Promise<{ project: ProjectDoc; state: StateDoc | null }> {
  const c = await scoped(s);
  const project = await resolveProject(c, s, key, { create: false });
  if (!project) throw new NotFoundError(`Project "${key.trim().slice(0, 120)}" not found`);
  return { project, state: await c.states.findOne({ _id: project._id }) };
}

/** The State of a project the caller reads, or null (none yet, or not visible). For pages. */
export async function stateOfProject(s: Scope, projectId: string): Promise<StateDoc | null> {
  return (await scoped(s)).states.findOne({ _id: projectId });
}

export type SaveResult =
  | { conflict: true; state: StateDoc | null; project: ProjectDoc }
  | {
      conflict?: false;
      state: StateDoc;
      project: ProjectDoc;
      done: string[];
      dropped: string[];
      promoted: { ref: number; title: string }[];
      /** Tasks whose Next line was finished here and that are now Done. */
      closedTasks: number[];
      /** Tasks whose Next line was finished here but that went to review (an agent finishing code, data or client work). */
      sentForReview: number[];
      /** Tasks that could not be closed: "#13: reason". */
      leftOpen: string[];
    };

export async function saveState(s: Scope, projectKey: string, rawOps: unknown, o: { baseVersion?: number; actor: Actor; via: Via; msg?: { id: string; author: string; word: string } }): Promise<SaveResult> {
  const ops = StateOpsSchema.parse(rawOps);
  // Refs of Next lines finished by this call: their tasks finish after the transaction (the line is gone already, so there is no loop back).
  const doneRefs: number[] = [];
  const r = await inTransaction(async () => {
    doneRefs.length = 0;
    const c = await scoped(s);
    const project = await resolveProject(c, s, projectKey, { create: false });
    if (!project) throw new NotFoundError(`Project "${projectKey.trim().slice(0, 120)}" not found`);
    let cur = await c.states.findOne({ _id: project._id });
    if (ops.some(x => VERSIONED.has(x.op))) {
      if (o.baseVersion === undefined) throw new InputError('set_now needs base_version: the version of the State you read (start_work, get_state and every save_state answer carry it).');
      // Nothing is written; the caller merges and retries.
      if ((cur?.version ?? 0) !== o.baseVersion) return { conflict: true as const, state: cur, project };
    }
    const now = new Date();
    if (!cur) {
      // The first write makes the State, stamped with the project's placement.
      await c.states.updateOne(
        { _id: project._id },
        { $setOnInsert: { ...placeIn(project, s.userId), projectId: project._id, now: null, next: [], later: [], decisions: [], where: {}, version: 0, createdAt: now, updatedAt: now } },
        { upsert: true },
      );
      cur = await c.states.findOne({ _id: project._id });
      if (!cur) throw new InputError('Could not create the State');
    }
    const by = s.userId;
    const rc = requestContext();
    const src = rc.src;
    const stamp = { by, ...(src ? { src } : {}) };
    const log: NonNullable<StateDoc['log']> = ops.map(op => ({ at: now, by, ...(rc.keyId ? { key: rc.keyId } : {}), ...(src ? { src } : {}), via: o.via, op: op.op, ...('id' in op && op.id ? { id: op.id } : {}) }));
    // At most 30 decisions an hour from one key: a runaway agent cannot bury the real ones.
    if (ops.some(x => x.op === 'add_decision')) {
      const hourAgo = now.getTime() - 3_600_000;
      const recent = cur.decisions.filter(d => d.at.getTime() > hourAgo && (rc.keyId ? d.key === rc.keyId : d.by === by)).length;
      if (recent + ops.filter(x => x.op === 'add_decision').length > 30) throw new InputError('That is more than 30 decisions an hour from one key. Wait a while, or record fewer.');
    }
    const decisionsAll = [...cur.decisions];
    let decisionsEdited = false;
    const next = [...cur.next];
    const later = [...cur.later];
    const nextAdds: StateLine[] = [];
    const laterAdds: StateLine[] = [];
    const decisions: StateDoc['decisions'] = [];
    const where: Record<string, unknown> = {};
    let nowSet: StateDoc['now'] | undefined;
    let nextEdited = false;
    let laterEdited = false;
    const done: string[] = [];
    const dropped: string[] = [];
    const promoted: { ref: number; title: string }[] = [];
    // The activity feed: one row per change worth reading (Now, a Next line added or done, a Later line, a decision).
    const feed: { type: 'state_now' | 'next_added' | 'next_done' | 'later_added' | 'decision'; text: string; by?: string }[] = [];
    const take = (list: StateLine[], id: string, what: string): StateLine => {
      const i = list.findIndex(l => l.id === id);
      if (i < 0) throw new InputError(`${what} has no line ${id} (read the State again for current ids)`);
      return list.splice(i, 1)[0];
    };
    type Hit = { where: string; line?: StateLine; i: number; id?: string; text: string };
    // The one line holding `find` (case-sensitive substring) among the given lists; zero or several matches throw, naming the candidates.
    const findLine = (find: string, where: ('Now' | 'Next' | 'Later' | 'Decisions')[], onlyId?: string): Hit => {
      const hits: Hit[] = [];
      const cn = nowSet ?? cur!.now;
      if (where.includes('Now') && !onlyId && cn && cn.text.includes(find)) hits.push({ where: 'Now', i: 0, text: cn.text });
      if (where.includes('Next')) next.forEach((l, i) => l.text.includes(find) && (!onlyId || l.id === onlyId) && hits.push({ where: 'Next', line: l, i, id: l.id, text: l.text }));
      if (where.includes('Later')) later.forEach((l, i) => l.text.includes(find) && (!onlyId || l.id === onlyId) && hits.push({ where: 'Later', line: l, i, id: l.id, text: l.text }));
      if (where.includes('Decisions')) decisionsAll.forEach((d, i) => !d.archivedAt && d.text.includes(find) && hits.push({ where: 'Decisions', i, id: d.id, text: d.text }));
      const quote = (t: string) => `"${t.length > 80 ? t.slice(0, 77) + '...' : t}"`;
      if (!hits.length) throw new InputError(`find ${quote(find)} matches no line in ${onlyId ? `line ${onlyId}` : where.join(', ')} (case-sensitive; read the State again). Nothing was written.`);
      if (hits.length > 1) throw new InputError(`find ${quote(find)} matches ${hits.length} lines: ${hits.slice(0, 6).map(h => `${h.where} ${quote(h.text)}`).join('; ')}. Use more of the line's text so it matches one. Nothing was written.`);
      return hits[0];
    };
    for (const [oi, op] of ops.entries()) {
      if (op.op === 'move_next' || op.op === 'done_next' || op.op === 'promote_later' || op.op === 'archive_decision') {
        if (op.find !== undefined && op.id) throw new InputError(`${op.op}: give id or find, not both.`);
        if (op.find === undefined && !op.id) throw new InputError(`${op.op} needs id or find.`);
      }
      switch (op.op) {
        case 'set_now':
          nowSet = { text: op.text, ...(op.holder ? { holder: op.holder } : {}), by, at: now };
          feed.push({ type: 'state_now', text: op.text });
          break;
        case 'add_next': {
          const l: StateLine = { id: lid(), text: op.text, ...(op.ref ? { ref: op.ref } : {}), ...(op.waits_on ? { waitsOn: op.waits_on } : {}), ...stamp, at: now };
          nextAdds.push(l);
          next.push(l);
          feed.push({ type: 'next_added', text: op.text });
          break;
        }
        case 'move_next': {
          nextEdited = true;
          const l = take(next, op.find !== undefined ? findLine(op.find, ['Next']).id! : op.id!, 'Next');
          log[oi].id = l.id;
          const at = op.to === 'top' ? 0 : op.to === 'bottom' ? next.length : Math.min(op.to - 1, next.length);
          next.splice(at, 0, l);
          break;
        }
        case 'done_next': {
          nextEdited = true;
          const l = take(next, op.find !== undefined ? findLine(op.find, ['Next']).id! : op.id!, 'Next');
          log[oi].id = l.id;
          if (l.ref) doneRefs.push(l.ref);
          done.push(l.text);
          feed.push({ type: 'next_done', text: l.text, by: l.by });
          break;
        }
        case 'add_later': {
          const l: StateLine = { id: lid(), text: op.text, ...(op.waits_on ? { waitsOn: op.waits_on } : {}), ...stamp, at: now };
          laterAdds.push(l);
          later.push(l);
          feed.push({ type: 'later_added', text: op.text });
          break;
        }
        case 'promote_later': {
          laterEdited = true;
          const l = take(later, op.find !== undefined ? findLine(op.find, ['Later']).id! : op.id!, 'Later');
          log[oi].id = l.id;
          // It becomes a task in this project, by the caller (the line's words become the title).
          const t = await createTask(s, { title: l.text.slice(0, 300), project: project._id, priority: (op.priority ?? 'P3') as Priority, ...(l.text.length > 300 ? { description: l.text } : {}) }, o.actor, l.by !== by ? { authors: { title: userActor(l.by), ...(l.text.length > 300 ? { description: userActor(l.by) } : {}) } } : {});
          promoted.push({ ref: t.ref, title: t.title });
          break;
        }
        case 'add_decision':
          decisions.push({ id: lid(), at: now, ...stamp, via: o.via, text: op.text, ...(rc.keyId ? { key: rc.keyId } : {}), ...(o.msg ? { msg: o.msg.id, author: o.msg.author, word: o.msg.word } : {}) });
          feed.push({ type: 'decision', text: op.text, ...(o.msg ? { by: o.msg.author } : {}) });
          break;
        case 'archive_decision': {
          if (!isPerson(o.actor)) throw new InputError('A decision is archived by a person in the app, not through MCP.');
          const did = op.find !== undefined ? findLine(op.find, ['Decisions']).id : op.id;
          const d = decisionsAll.find(x => x.id === did && !x.archivedAt);
          if (!d) throw new InputError(`Decisions has no open entry ${did}`);
          log[oi].id = d.id;
          const may = project.ownerId === s.userId || (await (await import('../caller')).roleOf(s.userId, s.orgId)) === 'owner';
          if (!may) throw new InputError("Only the project's owner or an owner of the organization can archive a decision.");
          d.archivedAt = now;
          decisionsEdited = true;
          break;
        }
        case 'edit_line': {
          const h = findLine(op.find, ['Now', 'Next', 'Later'], op.id);
          const replaced = h.text.replace(op.find, () => op.new).trim();
          if (h.where === 'Now') {
            if (!replaced) throw new InputError('Now cannot be removed: replace it with set_now.');
            if (replaced.length > LIMITS.now) throw new InputError(`Now would be ${replaced.length} characters (max ${LIMITS.now}).`);
            nowSet = { ...(nowSet ?? cur.now!), text: replaced, by, at: now };
            feed.push({ type: 'state_now', text: replaced });
            break;
          }
          if (replaced.length > LIMITS.line) throw new InputError(`The line would be ${replaced.length} characters (max ${LIMITS.line}).`);
          const list = h.where === 'Next' ? next : later;
          if (h.where === 'Next') nextEdited = true;
          else laterEdited = true;
          log[oi].id = h.id;
          if (!replaced) {
            list.splice(h.i, 1);
            (h.where === 'Next' ? done : dropped).push(h.text);
            if (h.where === 'Next' && h.line!.ref) doneRefs.push(h.line!.ref);
            if (h.where === 'Next') feed.push({ type: 'next_done', text: h.text, by: h.line!.by });
          } else {
            const { src: oldSrc, ...rest } = h.line!;
            void oldSrc;
            list[h.i] = { ...rest, ...stamp, text: replaced, at: now };
          }
          break;
        }
        case 'set_where':
          where[`where.${machineKey(op.machine)}`] = { ...(op.branch ? { branch: op.branch } : {}), ...(op.head ? { head: op.head } : {}), ...(op.dirty !== undefined ? { dirty: op.dirty } : {}), ...(op.worktrees ? { worktrees: op.worktrees } : {}), at: now, by };
          break;
      }
    }
    if (next.length > LIMITS.next) throw new InputError(`Next would hold ${next.length} lines (max ${LIMITS.next}): finish or drop some first.`);
    if (later.length > LIMITS.later) throw new InputError(`Later would hold ${later.length} lines (max ${LIMITS.later}): promote or drop some first.`);
    if (cur.decisions.filter(x => !x.archivedAt).length + decisions.length > LIMITS.decisions) throw new InputError(`Decisions would hold more than ${LIMITS.decisions} entries.`);
    if (Object.keys(cur.where).length + Object.keys(where).filter(k => !Object.hasOwn(cur.where, k.slice(6))).length > 40) throw new InputError('Where tracks at most 40 machines.');

    const set: Record<string, unknown> = { updatedAt: now, ...where };
    const push: Record<string, unknown> = {};
    if (nowSet) set.now = nowSet;
    if (nextEdited) set.next = next;
    else if (nextAdds.length) push.next = { $each: nextAdds };
    if (laterEdited) set.later = later;
    else if (laterAdds.length) push.later = { $each: laterAdds };
    if (decisionsEdited) set.decisions = [...decisionsAll, ...decisions];
    else if (decisions.length) push.decisions = { $each: decisions };
    push.log = { $each: log, $slice: -200 };
    const r = await c.states.updateOne({ _id: cur._id, version: cur.version }, { $set: set, $inc: { version: 1 }, ...(Object.keys(push).length ? { $push: push } : {}) } as never);
    if (!r.matchedCount) throw new InputError('The State changed while you saved: read it again and retry.');
    // Placed like the State (its project's readers), and moved with the project (setProjectPlacement, by projectId).
    for (const f of feed) await logChange(c, cur, o.actor, f.type, { subject: { kind: 'state', id: project._id, title: 'State' }, projectId: project._id, note: f.text, ...(f.by ? { textBy: f.by } : {}), at: now });
    const state = (await c.states.findOne({ _id: cur._id }))!;
    return { state, project, done, dropped, promoted, closedTasks: [] as number[], sentForReview: [] as number[], leftOpen: [] as string[] };
  });
  if (r.conflict || !doneRefs.length) return r;
  // A Next line with a task ref finishes its task. A person closes it; an agent closing code, data or client work opens a review instead.
  for (const ref of [...new Set(doneRefs)]) {
    try {
      const t = await getTask(s, ref);
      if (!t || t.status === 'Done' || t.status === 'Dropped') continue;
      const closed = await completeTask(s, ref, 'Its Next line was finished in the State', o.actor);
      (closed.status === 'Done' ? r.closedTasks : r.sentForReview).push(ref);
    } catch (e) {
      r.leftOpen.push(`#${ref}: ${e instanceof Error ? e.message : 'could not be closed'}`);
    }
  }
  return r;
}

/**
 * A task ended (Done or Dropped): its Next lines come off every State the caller can read, whatever the project. One version
 * bump, a log entry and a feed row per State. Runs in the caller's transaction (tasks.ts updateTaskCore). A State the
 * closer cannot read is left alone.
 */
export async function closeNextForTask(c: Awaited<ReturnType<typeof scoped>>, s: Scope, ref: number, status: 'Done' | 'Dropped', actor: Actor): Promise<void> {
  const states = await c.states.find({ 'next.ref': ref }).toArray();
  const rc = requestContext();
  for (const st of states) {
    const gone = st.next.filter(l => l.ref === ref);
    if (!gone.length) continue;
    const now = new Date();
    const log = gone.map(l => ({ at: now, by: s.userId, ...(rc.keyId ? { key: rc.keyId } : {}), ...(rc.src ? { src: rc.src } : {}), via: isPerson(actor) ? 'app' : 'code', op: 'task_closed', id: l.id }));
    const u = await c.states.updateOne(
      { _id: st._id, version: st.version },
      { $set: { next: st.next.filter(l => l.ref !== ref), updatedAt: now }, $inc: { version: 1 }, $push: { log: { $each: log, $slice: -200 } } } as never,
    );
    if (!u.matchedCount) continue;
    for (const l of gone) await logChange(c, st, actor, 'next_done', { subject: { kind: 'state', id: st.projectId, title: 'State' }, projectId: st.projectId, note: `Closed with #${ref} (${status}): ${l.text}`, at: now });
  }
}

/**
 * Where a session works: branch, head, uncommitted changes, worktrees. Written by the start hook, not by a save: no version
 * bump, no log, no feed (so a start never makes another session's version stale). At most 40 machines.
 */
export async function setWhere(s: Scope, projectId: string, machine: string, w: { branch?: string; head?: string; dirty?: boolean; worktrees?: string[] }): Promise<void> {
  const c = await scoped(s);
  const key = machineKey(machine);
  const cur = await c.states.findOne({ _id: projectId }, { projection: { where: 1 } });
  if (!cur) return; // no State yet: nothing to attach it to
  if (!Object.hasOwn(cur.where ?? {}, key) && Object.keys(cur.where ?? {}).length >= 40) return;
  const entry = { ...(w.branch ? { branch: w.branch.slice(0, 200) } : {}), ...(w.head ? { head: w.head.slice(0, 80) } : {}), ...(w.dirty !== undefined ? { dirty: w.dirty } : {}), ...(w.worktrees ? { worktrees: w.worktrees.slice(0, 20).map(x => x.slice(0, 200)) } : {}), at: new Date(), by: s.userId };
  await c.states.updateOne({ _id: projectId }, { $set: { [`where.${key}`]: entry } } as never);
}

// ── Import: a repo's WORK-STATE.md, once ────────────────────────────────────

export type ParsedWorkState = { now: string; next: { text: string; waitsOn?: string }[]; later: { text: string; waitsOn?: string }[]; skipped: { section: string; lines: number }[]; /** Lines (and Now) that were over the limit and cut. */ shortened: number };

/** Sections that are a record of the past, not the plan: never imported (they would flood Later). They belong in docs/history.md. */
const PAST = /^(history|log|changelog|change log|changes|done|completed|shipped|archive|journal|timeline|session log|progress log|releases?)\b/i;

const BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const WAITS = /\s+[—–-]{1,2}\s+(?:waits|waiting) on\s+(.+?)\.?\s*$/i;

/**
 * A line within the limit is kept whole. A longer one is cut after the last sentence end (. ! ? or ; before a space) that
 * fits, if that keeps at least 40% of the limit; else at the last space, with an ellipsis. The rest is dropped, never made
 * into a new line.
 */
export function fitLine(raw: string, max: number): { text: string; cut: boolean } {
  const s = raw.trim();
  if (s.length <= max) return { text: s, cut: false };
  let end = -1;
  for (const m of s.slice(0, max + 1).matchAll(/[.!?;](?=\s)/g)) end = m.index! + 1;
  if (end >= max * 0.4) return { text: s.slice(0, end).trim(), cut: true };
  const sp = s.lastIndexOf(' ', max - 1);
  return { text: (s.slice(0, sp > 0 ? sp : max - 1).trimEnd() + '\u2026').slice(0, max), cut: true };
}

/** Now / Next / Later sections of a WORK-STATE.md. Lines in other sections come back as Later lines, so nothing is lost; text above Now is skipped and counted; History, log and similar sections (PAST) are skipped and counted. */
export function parseWorkState(md: string): ParsedWorkState {
  type Sec = 'pre' | 'now' | 'next' | 'later' | 'other' | 'past';
  let sec: Sec = 'pre';
  let other = '';
  const skipped: { section: string; lines: number }[] = [];
  let level = 0; // heading level of the skipped section: deeper headings stay inside it
  const items: Record<'now' | 'next' | 'later' | 'stray' | 'above', string[]> = { now: [], next: [], later: [], stray: [], above: [] };
  const last: { at: { into: keyof typeof items; i: number } | null } = { at: null };
  const add = (into: keyof typeof items, t: string) => {
    items[into].push(t.trim());
    last.at = { into, i: items[into].length - 1 };
  };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) {
      last.at = null;
      continue;
    }
    const h = raw.match(HEADING);
    const depth = h ? raw.match(/^#+/)![0].length : 0;
    if (sec === 'past' && (!h || depth > level)) {
      if (!h) skipped[skipped.length - 1].lines++;
      continue;
    }
    if (h) {
      const name = h[1].trim().toLowerCase();
      last.at = null;
      if (PAST.test(name)) {
        sec = 'past';
        level = depth;
        skipped.push({ section: h[1].trim().slice(0, 80), lines: 0 });
      } else if (name === 'now' || name === 'next' || name === 'later') sec = name;
      else if (/^work[ -]state\b/.test(name)) sec = 'pre';
      else {
        sec = 'other';
        other = h[1].trim();
      }
      continue;
    }
    if (/^[>_*\s]*Copy of the Work OS state/i.test(raw)) continue; // the header save_state writes
    const target: keyof typeof items = sec === 'now' ? 'now' : sec === 'next' ? 'next' : sec === 'later' ? 'later' : sec === 'pre' ? 'above' : 'stray';
    const prefix = sec === 'other' && other ? `[${other}] ` : '';
    const b = raw.match(BULLET);
    if (b && !/^\s{2,}/.test(raw)) add(target, prefix + b[1]);
    else if (last.at && last.at.into === target) items[last.at.into][last.at.i] += ' ' + raw.trim().replace(BULLET, '$1'); // an indented or wrapped line belongs to the item above
    else add(target, prefix + raw.trim());
  }
  let shortened = 0;
  const fit = (text: string, max: number) => {
    const f = fitLine(text, max);
    if (f.cut) shortened++;
    return f.text;
  };
  const lines = (list: string[]) => list.map(x => fit(x, LIMITS.line)).map(x => ({ text: x, ...(WAITS.exec(x) ? { waitsOn: WAITS.exec(x)![1].slice(0, 200) } : {}) }));
  if (items.above.length) skipped.push({ section: 'Text above Now', lines: items.above.length });
  // What does not fit stays whole: Next lines past the cap and stray lines go to Later. A cut line's rest is dropped, never a new line.
  const nextAll = lines(items.next);
  return {
    now: fit(items.now.join(' '), LIMITS.now),
    next: nextAll.slice(0, LIMITS.next),
    later: [...nextAll.slice(LIMITS.next), ...lines(items.later), ...lines(items.stray)].slice(0, LIMITS.later),
    skipped,
    shortened,
  };
}

export async function importState(s: Scope, projectKey: string, markdown: string, o: { actor: Actor }): Promise<{ state: StateDoc; project: ProjectDoc; imported: { now: boolean; next: number; later: number }; skipped: ParsedWorkState['skipped']; shortened: number }> {
  if (!markdown.trim()) throw new InputError('markdown is empty');
  if (markdown.length > 200_000) throw new InputError('markdown is over 200,000 characters');
  void o;
  return inTransaction(async () => {
    const c = await scoped(s);
    const project = await resolveProject(c, s, projectKey, { create: false });
    if (!project) throw new NotFoundError(`Project "${projectKey.trim().slice(0, 120)}" not found`);
    const existing = await c.states.findOne({ _id: project._id }, { projection: { version: 1 } });
    if (existing) throw new InputError(`${project.name} already has a State (version ${existing.version}). import_state is for a project with none; use save_state to change it.`);
    const p = parseWorkState(markdown);
    const now = new Date();
    const by = s.userId;
    const line = (l: { text: string; waitsOn?: string }): StateLine => ({ id: lid(), text: l.text, ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), by, at: now });
    const doc: StateDoc = {
      _id: project._id,
      orgId: s.orgId,
      ...placeIn(project, s.userId),
      projectId: project._id,
      now: p.now ? { text: p.now, by, at: now } : null,
      next: p.next.map(line),
      later: p.later.map(line),
      decisions: [],
      where: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await c.states.insertOne(doc);
    return { state: doc, project, imported: { now: !!p.now, next: doc.next.length, later: doc.later.length }, skipped: p.skipped, shortened: p.shortened };
  });
}

// ── Reading it out ──────────────────────────────────────────────────────────

/** Who wrote a line, for output: `writtenBy` only when it is not the reader. */
export type Names = Record<string, string>;
const label = (names: Names, reader: string, by: string): string | undefined => (by === reader ? undefined : names[by] || 'a former member');

export type StateOut = {
  version: number;
  now: { text: string; holder?: string; at: string; writtenBy?: string } | null;
  next: { id: string; text: string; ref?: number; waitsOn?: string; writtenBy?: string }[];
  later: { id: string; text: string; waitsOn?: string; writtenBy?: string }[];
  decisions: { id: string; at: string; by: string; via: string; text: string; message?: string; word?: string; writtenBy?: string }[];
  where: Record<string, { branch?: string; head?: string; dirty?: boolean; worktrees?: string[]; at: string; writtenBy?: string }>;
  updatedAt: string;
};

/** The State as plain data (dates as ISO strings), lines by anyone but the reader labelled `writtenBy`. */
export function stateOut(d: StateDoc, reader: string, names: Names): StateOut {
  const w = (by: string) => {
    const l = label(names, reader, by);
    return l ? { writtenBy: l } : {};
  };
  return {
    version: d.version,
    now: d.now ? { text: d.now.text, ...(d.now.holder ? { holder: d.now.holder } : {}), at: d.now.at.toISOString(), ...w(d.now.by) } : null,
    next: d.next.map(l => ({ id: l.id, text: l.text, ...(l.ref ? { ref: l.ref } : {}), ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), ...w(l.by) })),
    later: d.later.map(l => ({ id: l.id, text: l.text, ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), ...w(l.by) })),
    decisions: d.decisions.filter(x => !x.archivedAt).map(x => ({ id: x.id, at: x.at.toISOString(), by: names[x.by] || 'a former member', via: x.via, text: x.text, ...(x.msg ? { message: x.msg } : {}), ...(x.word ? { word: x.word } : {}), ...w(x.author ?? x.by) })),
    where: Object.fromEntries(Object.entries(d.where ?? {}).map(([m, v]) => [m, { ...(v.branch ? { branch: v.branch } : {}), ...(v.head ? { head: v.head } : {}), ...(v.dirty !== undefined ? { dirty: v.dirty } : {}), ...(v.worktrees?.length ? { worktrees: v.worktrees } : {}), at: v.at.toISOString(), ...w(v.by) }])),
    updatedAt: d.updatedAt.toISOString(),
  };
}


/**
 * WORK-STATE.md as the repo copy of the State, headed with the version it came from. The same text for every reader (no
 * "(by X)"), so two PCs never commit different copies, and no Where (it changes with every session's head). Decisions are
 * listed only when `decisions` is true: leave them out for a public repo (lib/data/repo-visibility.ts).
 */
export function stateMarkdown(d: StateDoc, o: { projectName: string; url: string; names: Names; decisions?: boolean; /** Ignored: kept so older callers still compile. */ reader?: string }): string {
  const wait = (l: StateLine) => (l.waitsOn && !l.text.toLowerCase().includes(l.waitsOn.toLowerCase()) ? ` \u2014 waits on ${l.waitsOn}` : '');
  const out: string[] = [`Copy of the Work OS state, version ${d.version}. WORK-STATE.md is a copy of the State, written by the Work OS hook; never edit it. Change the State in Work OS (${o.url}).`, '', `# Work state: ${o.projectName}`, '', '## Now'];
  out.push(d.now ? `- ${d.now.text}${d.now.holder ? ` (${d.now.holder})` : ''}` : '- (nothing set)');

  out.push('', '## Next');
  if (d.next.length) d.next.forEach((l, i) => out.push(`${i + 1}. ${l.text}${l.ref ? ` (#${l.ref})` : ''}${wait(l)}`));
  else out.push('- (empty)');
  out.push('', '## Later');
  if (d.later.length) for (const l of d.later) out.push(`- ${l.text}${wait(l)}`);
  else out.push('- (empty)');
  const live = o.decisions ? d.decisions.filter(x => !x.archivedAt) : [];
  if (live.length) {
    out.push('', '## Decisions');
    for (const x of live.slice(-30)) out.push(`- ${x.at.toISOString().slice(0, 10)}: ${x.text} (${o.names[x.by] || 'a former member'}, ${x.via})`);
  }
  return out.join('\n') + '\n';
}
