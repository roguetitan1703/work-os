import 'server-only';
import { requestContext } from '../request-context';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { inTransaction, type ArchivedLine, type DeclutterCache, type PresenceDoc, type ProjectDoc, type StateDoc, type StateLine } from '../db';
import { scoped, type Scope } from '../scope';
import { isPerson, userActor, type Actor } from '../actors';
import { busy, dispatchedText, lineHeldText, lineHolder, nowHeldText, stateWord } from './lanes';
import { presenceState } from './presence-state';
import { InputError, NotFoundError } from './errors';
import { placeIn, resolveProject } from './projects';
import { decisionsInCopy } from './repo-visibility';
import { memberNames } from '../people';
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
//
// Lanes step 1 (plan note 666b20a6e9): the Now holder and held lines. A person (the app, Discord, Declutter) is never refused and
// keeps whatever hold there is. A session is named by its key `userId:key` (the form presence rows and pickup.ts use; the hook's
// State route sends a bare session id, normalised here).
//   Now (set_now, edit_line on Now): no holder -> the caller takes it; the caller holds it -> fine; the holder is busy (working,
//     or at a permission prompt) -> refused; else the hold moves and the old holder gets an fyi message. A dispatched run never
//     sets Now. set_now's `holder` argument is ignored.
//   Held lines (done_next, edit_line, archive_line, promote_later): only by the line's holder (its `hold`, or a live session on
//     its task by set_doing), the Now holder or a person. edit_line by a session holds the line.

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
  // (Next: done, Later: dropped and archived with its text). The edited line becomes the caller's.
  // `id` (optional) narrows the search to that Next or Later line, which must hold `find`.
  z.object({ op: z.literal('edit_line'), find: z.string().min(1).max(LIMITS.line), new: z.string().max(LIMITS.line), id: lineId }),
  // Takes a Next or Later line off the State and keeps its text in `archived` (Declutter, or a session tidying): nothing is lost,
  // a person puts it back from the State card. It does not finish the line's task.
  z.object({ op: z.literal('archive_line'), id: lineId, find: findText, why: z.string().trim().max(200).optional() }),
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

/**
 * The ops an agent sees in the MCP schema: no archive_decision (app only) and no set_now `holder` (Work OS records the session
 * that sets Now). The server still checks both, for any other path in.
 */
export const AgentStateOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_now'), text: text(LIMITS.now) }),
  ...StateOpSchema.options.filter(o => o.shape.op.value !== 'set_now' && o.shape.op.value !== 'archive_decision'),
]);
export const StateOpsSchema = z.array(StateOpSchema).min(1).max(30);
/** The ops that need base_version: set_now overwrites what a teammate may have just changed. The others are checked per line. */
const VERSIONED = new Set(['set_now']);

/** How many archived lines a State keeps (the newest). */
export const ARCHIVED_KEEP = 300;

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

/** One project's goal for the Projects list: Now's text, the first Next line and the State version. */
export type NowLine = { now: string | null; next: string | null; version: number };

/**
 * The Now and first Next line of many projects in one query (the Projects list): only those fields are read, never the whole
 * State. Through the caller's door like every read, so a project the caller cannot read has no entry.
 */
export async function nowOfProjects(s: Scope, ids: string[]): Promise<Record<string, NowLine>> {
  if (!ids.length) return {};
  const rows = await (await scoped(s)).states.find({ _id: { $in: ids } }, { projection: { 'now.text': 1, next: { $slice: 1 }, version: 1 } }).toArray();
  return Object.fromEntries(rows.map(d => [String(d._id), { now: d.now?.text ?? null, next: d.next?.[0]?.text ?? null, version: d.version }]));
}

/** A session's key as holds name it (`userId:key`): an MCP src already has the form, the hook's State route sends a bare session id. */
export function holdKeyOf(userId: string, src: string | undefined | null): string | undefined {
  if (!src) return undefined;
  return src.startsWith(`${userId}:`) ? src : `${userId}:${src}`;
}

/** Does the session `key` (`userId:key`) hold this State's Now? */
export const holdsNowOf = (d: Pick<StateDoc, 'now'> | null | undefined, key: string | undefined): boolean => !!key && d?.now?.hold?.key === key;

/** set_now or an edit of Now from a session Work OS has no presence row for (on this project). */
export const NO_SESSION = 'Now is held by sessions Work OS knows: pass the session id start_work gave you (session) and call again. Nothing was written.';

const splitKey = (k: string) => {
  const i = k.indexOf(':');
  return { userId: k.slice(0, i), key: k.slice(i + 1) };
};

export type SaveResult =
  | { conflict: true; state: StateDoc | null; project: ProjectDoc; holdsNow: boolean }
  | {
      conflict?: false;
      state: StateDoc;
      project: ProjectDoc;
      /** True when the calling session holds Now after this save (always false for a person). */
      holdsNow: boolean;
      /** Things the caller should know about how its ops were taken (set_now's holder ignored). */
      notes: string[];
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
  // The session whose Now hold this save moved away (it gets an fyi after the transaction).
  const took: { from: { row: PresenceDoc; label: string; mine: PresenceDoc | null } | null } = { from: null };
  const rc0 = requestContext();
  // A person (the app, Discord, Declutter) is never refused by a hold and never takes one.
  const person = isPerson(o.actor) || o.actor.kind === 'discord';
  const me = holdKeyOf(s.userId, rc0.src) ?? `${s.userId}:${rc0.keyId ?? 'agent'}`;
  const r = await inTransaction(async () => {
    doneRefs.length = 0;
    took.from = null;
    const c = await scoped(s);
    const project = await resolveProject(c, s, projectKey, { create: false });
    if (!project) throw new NotFoundError(`Project "${projectKey.trim().slice(0, 120)}" not found`);
    let cur = await c.states.findOne({ _id: project._id });
    if (ops.some(x => VERSIONED.has(x.op))) {
      if (o.baseVersion === undefined) throw new InputError('set_now needs base_version: the version of the State you read (start_work, get_state and every save_state answer carry it).');
      // Nothing is written; the caller merges and retries.
      if ((cur?.version ?? 0) !== o.baseVersion) return { conflict: true as const, state: cur, project, holdsNow: !person && holdsNowOf(cur, me) };
    }
    // An edit_line on Now by a session is checked up front like set_now (nothing runs on a conflict, so earlier ops of the batch such as promote_later leave nothing behind).
    if (!person && cur?.now && ops.some(x => x.op === 'edit_line' && !x.id && cur!.now!.text.includes(x.find))) {
      if (o.baseVersion === undefined) throw new InputError('edit_line on Now needs base_version: the version of the State you read (start_work, get_state and every save_state answer carry it). Nothing was written.');
      if (cur.version !== o.baseVersion) return { conflict: true as const, state: cur, project, holdsNow: holdsNowOf(cur, me) };
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
    const src = rc.src ? me : undefined;
    const stamp = { by, ...(src ? { src } : {}) };
    const notes: string[] = [];
    // ── Lanes: holds. Presence rows are read once, only when an op needs them.
    const st0 = cur;
    const rows = new Map<string, Promise<PresenceDoc | null>>();
    const rowOf = (k: string) => {
      if (!rows.has(k)) rows.set(k, c.presence.findOne({ projectId: project._id, ...splitKey(k) } as never, { sort: { lastSeen: -1 } }));
      return rows.get(k)!;
    };
    let names: Names | null = null;
    const nameOf = async (userId: string) => (names ??= await memberNames(s.orgId))[userId] || 'a former member';
    const labelOf = (r: PresenceDoc | null) => r?.label || 'a session';
    // The Now hold as it stands after the ops so far (a person's save keeps it as it is).
    let nowHold: NonNullable<StateDoc['now']>['hold'] | undefined = cur.now?.hold;
    let nowChecked = false;
    const claimNow = async () => {
      if (person || nowChecked) return;
      nowChecked = true;
      const t = Date.now();
      const mine = await rowOf(me);
      const h = st0.now?.hold;
      const hRow = h && h.key !== me ? await rowOf(h.key) : null;
      const hState = hRow ? presenceState(hRow, { now: t }) : null;
      if (mine?.dispatched) throw new InputError(dispatchedText({ label: h && h.key !== me ? h.label || labelOf(hRow) : '', state: hState ? stateWord(hState) : 'off', ref: mine.dispatched.ref }));
      // Only a session Work OS knows (a presence row of the caller on this project) holds Now: a call that names no session, or one
      // that never started work here, would leave a hold nobody can see working.
      if (!mine) throw new InputError(NO_SESSION);
      // A session that has ended can neither take nor keep Now.
      if (mine.endedAt) throw new InputError('This session has ended, so it cannot set or hold Now. Start work again to get a session.');
      if (h && h.key === me) {
        nowHold = { key: me, label: mine?.label || h.label, at: h.at };
        return;
      }
      if (h && hRow && busy(hRow, t)) {
        throw new InputError(nowHeldText({ label: h.label || labelOf(hRow), person: await nameOf(hRow.userId), state: stateWord(hState!), at: hState!.since }, t));
      }
      // No holder, or a holder that is not busy (or has no row on this project any more): the hold is the caller's. A holder whose
      // session has ended is not told (nobody would read it).
      if (h && hRow && !hRow.endedAt) took.from = { row: hRow, label: labelOf(mine), mine };
      nowHold = { key: me, label: labelOf(mine), at: now };
    };
    // Who may change a line: the row its hold names and the rows of sessions on its task (set_doing) on this project, each with the
    // task ref it is on. Read per line, only the rows that line needs.
    const lineRows = new Map<string, Promise<(PresenceDoc & { key: string; ref?: number })[]>>();
    const rowsFor = (l: StateLine) => {
      if (!lineRows.has(l.id)) {
        lineRows.set(
          l.id,
          (async () => {
            const out: (PresenceDoc & { key: string; ref?: number })[] = [];
            if (l.ref != null) {
              const task = await c.tasks.findOne({ ref: l.ref } as never, { projection: { _id: 1 } });
              if (task) for (const r of await c.presence.find({ projectId: project._id, 'doing.taskId': task._id } as never).toArray()) out.push({ ...r, key: `${r.userId}:${r.key}`, ref: l.ref });
            }
            const held = l.hold ? await rowOf(l.hold.key) : null;
            if (held && !out.some(r => r._id === held._id)) out.push({ ...held, key: `${held.userId}:${held.key}` });
            return out;
          })(),
        );
      }
      return lineRows.get(l.id)!;
    };
    /**
     * Refuses the op unless the caller may change the line; returns whether another live session holds it (an edit then keeps that
     * hold). Its holder and a person always may. The Now holder (merges) and a session on the line's task (set_doing) may only while
     * that holder is not busy. `move`: reordering, which only a busy holder's line refuses, and never to the Now holder.
     */
    const checkLine = async (l: StateLine, list: 'Next' | 'Later', o2: { move?: boolean } = {}): Promise<boolean> => {
      if (person) return false;
      if (!l.hold && l.ref == null) return false;
      const t = Date.now();
      const live = await rowsFor(l);
      const h = lineHolder(l, live, r => r.ref, t);
      if (!h || h.key === me) return false;
      const hBusy = busy(h, t);
      if (o2.move && (!hBusy || nowHold?.key === me)) return true;
      if (!o2.move && !hBusy) {
        if (nowHold?.key === me) return true;
        if (l.ref != null && live.some(r => r.key === me && r.ref === l.ref && presenceState(r, { now: t }).state !== 'off')) return true;
      }
      const text = lineHeldText({ id: l.id, text: l.text, label: labelOf(h), state: stateWord(presenceState(h, { now: t })), ref: l.ref, nowHolder: nowHold?.label });
      throw new InputError(list === 'Later' ? text.replace(/^Next line/, 'Later line') : text);
    };
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
    const archivedAdds: ArchivedLine[] = [];
    const archive = (l: StateLine, from: 'Next' | 'Later', why?: string) => {
      archivedAdds.push({ id: l.id, text: l.text, from, ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), by: l.by, at: l.at, archivedBy: by, archivedAt: now, ...(why ? { why } : {}) });
      feed.push({ type: 'line_archived', text: `${from} line: ${l.text}`, by: l.by });
    };
    const where: Record<string, unknown> = {};
    let nowSet: StateDoc['now'] | undefined;
    let nextEdited = false;
    let laterEdited = false;
    const done: string[] = [];
    const dropped: string[] = [];
    const promoted: { ref: number; title: string }[] = [];
    // The activity feed: one row per change worth reading (Now, a Next line added or done, a Later line, a decision).
    const feed: { type: 'state_now' | 'next_added' | 'next_done' | 'later_added' | 'line_archived' | 'decision'; text: string; by?: string }[] = [];
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
      if (op.op === 'move_next' || op.op === 'done_next' || op.op === 'promote_later' || op.op === 'archive_decision' || op.op === 'archive_line') {
        if (op.find !== undefined && op.id) throw new InputError(`${op.op}: give id or find, not both.`);
        if (op.find === undefined && !op.id) throw new InputError(`${op.op} needs id or find.`);
      }
      switch (op.op) {
        case 'set_now':
          await claimNow();
          if (op.holder !== undefined && !person && !notes.length) notes.push("set_now's holder is ignored: Work OS records the session that sets Now as its holder.");
          nowSet = { text: op.text, ...(nowHold ? { hold: nowHold } : {}), by, at: now };
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
          await checkLine(l, 'Next', { move: true });
          log[oi].id = l.id;
          const at = op.to === 'top' ? 0 : op.to === 'bottom' ? next.length : Math.min(op.to - 1, next.length);
          next.splice(at, 0, l);
          break;
        }
        case 'done_next': {
          nextEdited = true;
          const l = take(next, op.find !== undefined ? findLine(op.find, ['Next']).id! : op.id!, 'Next');
          await checkLine(l, 'Next');
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
          await checkLine(l, 'Later');
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
            // An edit of Now by a session overwrites the goal like set_now: the same base_version rule, the same conflict answer. A
            // person in the app is never refused.
            if (!person && o.baseVersion === undefined) throw new InputError('edit_line on Now needs base_version: the version of the State you read (start_work, get_state and every save_state answer carry it). Nothing was written.');
            if (!person && st0.version !== o.baseVersion) return { conflict: true as const, state: st0, project, holdsNow: holdsNowOf(st0, me) };
            await claimNow();
            nowSet = { text: replaced, ...(nowHold ? { hold: nowHold } : {}), by, at: now };
            feed.push({ type: 'state_now', text: replaced });
            break;
          }
          if (replaced.length > LIMITS.line) throw new InputError(`The line would be ${replaced.length} characters (max ${LIMITS.line}).`);
          const heldByOther = await checkLine(h.line!, h.where as 'Next' | 'Later');
          const list = h.where === 'Next' ? next : later;
          if (h.where === 'Next') nextEdited = true;
          else laterEdited = true;
          log[oi].id = h.id;
          if (!replaced) {
            list.splice(h.i, 1);
            if (h.where === 'Later') archive(h.line!, 'Later', 'removed with edit_line');
            (h.where === 'Next' ? done : dropped).push(h.text);
            if (h.where === 'Next' && h.line!.ref) doneRefs.push(h.line!.ref);
            if (h.where === 'Next') feed.push({ type: 'next_done', text: h.text, by: h.line!.by });
          } else {
            const { src: oldSrc, hold: oldHold, left: oldLeft, ...rest } = h.line!;
            void oldSrc;
            // A session that edits a line holds it. A person's edit, and the Now holder's edit of a line another live session holds,
            // keep the hold (and where a released one stood) as it was.
            const keep = person || heldByOther ? { ...(oldHold ? { hold: oldHold } : {}), ...(oldLeft ? { left: oldLeft } : {}) } : { hold: { key: me, at: now } };
            list[h.i] = { ...rest, ...stamp, ...keep, text: replaced, at: now };
          }
          break;
        }
        case 'archive_line': {
          let from: 'Next' | 'Later';
          let lid2: string;
          if (op.find !== undefined) {
            const h = findLine(op.find, ['Next', 'Later']);
            from = h.where as 'Next' | 'Later';
            lid2 = h.id!;
          } else if (next.some(l => l.id === op.id)) {
            from = 'Next';
            lid2 = op.id!;
          } else if (later.some(l => l.id === op.id)) {
            from = 'Later';
            lid2 = op.id!;
          } else throw new InputError(`Next and Later have no line ${op.id} (read the State again for current ids)`);
          const l = take(from === 'Next' ? next : later, lid2, from);
          await checkLine(l, from);
          if (from === 'Next') nextEdited = true;
          else laterEdited = true;
          log[oi].id = l.id;
          archive(l, from, op.why);
          dropped.push(l.text);
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

    // An unheld Now (set before Lanes) is taken by the first save of a session that may hold it: a main session (not dispatched, not
    // ended, no parent, so not a builder) with a presence row on this project. A hold that exists is never moved here.
    if (!person && !nowSet && cur.now && !cur.now.hold && !nowHold) {
      const mine = await rowOf(me);
      if (mine && !mine.dispatched && !mine.endedAt && !mine.parent) nowHold = { key: me, label: labelOf(mine), at: now };
    }
    const set: Record<string, unknown> = { updatedAt: now, ...where };
    if (nowHold && !nowSet && !cur.now?.hold && cur.now) set['now.hold'] = nowHold;
    const push: Record<string, unknown> = {};
    if (nowSet) set.now = nowSet;
    if (nextEdited) set.next = next;
    else if (nextAdds.length) push.next = { $each: nextAdds };
    if (laterEdited) set.later = later;
    else if (laterAdds.length) push.later = { $each: laterAdds };
    if (decisionsEdited) set.decisions = [...decisionsAll, ...decisions];
    else if (decisions.length) push.decisions = { $each: decisions };
    if (archivedAdds.length) push.archived = { $each: archivedAdds, $slice: -ARCHIVED_KEEP };
    push.log = { $each: log, $slice: -200 };
    const r = await c.states.updateOne({ _id: cur._id, version: cur.version }, { $set: set, $inc: { version: 1 }, ...(Object.keys(push).length ? { $push: push } : {}) } as never);
    if (!r.matchedCount) throw new InputError('The State changed while you saved: read it again and retry.');
    // Placed like the State (its project's readers), and moved with the project (setProjectPlacement, by projectId).
    for (const f of feed) await logChange(c, cur, o.actor, f.type, { subject: { kind: 'state', id: project._id, title: 'State' }, projectId: project._id, note: f.text, ...(f.by ? { textBy: f.by } : {}), at: now });
    const state = (await c.states.findOne({ _id: cur._id }))!;
    return { state, project, holdsNow: !person && holdsNowOf(state, me), notes, done, dropped, promoted, closedTasks: [] as number[], sentForReview: [] as number[], leftOpen: [] as string[] };
  });
  if (!r.conflict && took.from) await tellOldHolder(s, r.project, r.state, took.from, me, o);
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
 * The Now hold moved from a session that was not busy: that session gets an fyi on its own key (labels only, never a session id).
 * Never fails the save: a message that cannot be sent (the hourly limit) is skipped.
 */
async function tellOldHolder(s: Scope, project: ProjectDoc, state: StateDoc, from: { row: PresenceDoc; label: string; mine: PresenceDoc | null }, me: string, o: { actor: Actor; via: Via }): Promise<void> {
  try {
    const { sendMessage } = await import('./messages');
    const goal = state.now?.text ?? '';
    const body = `"${from.label}" took over Now on ${project.name}: ${goal.length > 200 ? `${goal.slice(0, 200)}…` : goal}. You no longer hold Now. Keep your lane: set_doing your task, log_progress, add_next or add_decision; send_message "${from.label}" if Now should change.`;
    await sendMessage(s, { kind: 'session', rows: [from.row], project }, { kind: 'fyi', body }, { word: o.via === 'chat' ? 'chat' : 'agent', ...(from.mine?.session ? { session: from.mine.session } : {}), label: from.label, ...(from.mine?.keyId ? { keyId: from.mine.keyId } : {}), src: me, actor: o.actor });
  } catch (e) {
    console.error('[state now moved]', e instanceof Error ? e.name : 'error');
  }
}

/**
 * Puts an archived line back at the end of Later (a person, from the State card). The line keeps its id, text, author and
 * what it waits on; it leaves `archived`. One version bump, a log entry and a feed row.
 */
export async function restoreLine(s: Scope, projectId: string, archivedId: string, actor: Actor): Promise<{ state: StateDoc; text: string }> {
  if (!isPerson(actor)) throw new InputError('An archived line is put back by a person in the app.');
  return inTransaction(async () => {
    const c = await scoped(s);
    const cur = await c.states.findOne({ _id: projectId });
    if (!cur) throw new NotFoundError('State not found');
    const a = (cur.archived ?? []).find(x => x.id === archivedId);
    if (!a) throw new InputError('That archived line is not there any more (it may already be back).');
    if (cur.later.length + 1 > LIMITS.later) throw new InputError(`Later would hold ${cur.later.length + 1} lines (max ${LIMITS.later}): promote or drop some first.`);
    const now = new Date();
    const rc = requestContext();
    const line: StateLine = { id: a.id, text: a.text, ...(a.waitsOn ? { waitsOn: a.waitsOn } : {}), by: a.by, at: now };
    const entry = { at: now, by: s.userId, ...(rc.keyId ? { key: rc.keyId } : {}), ...(rc.src ? { src: rc.src } : {}), via: 'app', op: 'restore_line', id: a.id };
    // One update: $pull and $push on different fields.
    const u = await c.states.updateOne(
      { _id: cur._id, version: cur.version },
      { $pull: { archived: { id: a.id } }, $push: { later: line, log: { $each: [entry], $slice: -200 } }, $set: { updatedAt: now }, $inc: { version: 1 } } as never,
    );
    if (!u.matchedCount) throw new InputError('The State changed while you saved: try again.');
    await logChange(c, cur, actor, 'later_added', { subject: { kind: 'state', id: projectId, title: 'State' }, projectId, note: a.text, textBy: a.by, at: now });
    return { state: (await c.states.findOne({ _id: cur._id }))!, text: a.text };
  });
}

/** What the daily Declutter check found, stored on the State without a version bump, log or feed row (like setWhere). */
export async function setDeclutterCache(s: Scope, projectId: string, cache: DeclutterCache): Promise<void> {
  const c = await scoped(s);
  await c.states.updateOne({ _id: projectId }, { $set: { declutter: cache } } as never);
}

/** The daily check's result: only checkedAt and reasons are written, so an Ask or an Apply racing it keeps quietUntil and needId. */
export async function setDeclutterReasons(s: Scope, projectId: string, checkedAt: Date, reasons: string[]): Promise<void> {
  const c = await scoped(s);
  await c.states.updateOne({ _id: projectId }, { $set: { 'declutter.checkedAt': checkedAt, 'declutter.reasons': reasons } } as never);
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
  /** holder: label of the session that holds Now; holderState: its state word (working, idle, ...), set by the page (roster.withLaneMarks). */
  now: { text: string; holder?: string; holderState?: string; at: string; writtenBy?: string } | null;
  /** holder: label of the session that holds the line (set by the page); left: where a released line stood, as one line of text. */
  next: { id: string; text: string; ref?: number; waitsOn?: string; holder?: string; left?: string; writtenBy?: string }[];
  later: { id: string; text: string; waitsOn?: string; holder?: string; left?: string; writtenBy?: string }[];
  decisions: { id: string; at: string; by: string; via: string; text: string; message?: string; word?: string; writtenBy?: string }[];
  where: Record<string, { branch?: string; head?: string; dirty?: boolean; worktrees?: string[]; at: string; writtenBy?: string }>;
  updatedAt: string;
};

/** An unheld line's `left`: who left it, on which branch, and the last log, as one line (labels only). */
const leftOut = (l: StateLine): { left?: string } => {
  if (!l.left || l.hold) return {};
  const parts = [`left by ${l.left.label}`, l.left.branch, l.left.log ? `last: ${l.left.log}` : l.left.head].filter(Boolean);
  return { left: parts.join(' · ') };
};

/** The State as plain data (dates as ISO strings), lines by anyone but the reader labelled `writtenBy`. */
export function stateOut(d: StateDoc, reader: string, names: Names): StateOut {
  const w = (by: string) => {
    const l = label(names, reader, by);
    return l ? { writtenBy: l } : {};
  };
  return {
    version: d.version,
    // holder: the label of the session that holds Now (never its id); a legacy free-text holder is shown until a save replaces it.
    now: d.now ? { text: d.now.text, ...(d.now.hold?.label || d.now.holder ? { holder: d.now.hold?.label || d.now.holder } : {}), at: d.now.at.toISOString(), ...w(d.now.by) } : null,
    next: d.next.map(l => ({ id: l.id, text: l.text, ...(l.ref ? { ref: l.ref } : {}), ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), ...leftOut(l), ...w(l.by) })),
    later: d.later.map(l => ({ id: l.id, text: l.text, ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), ...leftOut(l), ...w(l.by) })),
    decisions: d.decisions.filter(x => !x.archivedAt).map(x => ({ id: x.id, at: x.at.toISOString(), by: names[x.by] || 'a former member', via: x.via, text: x.text, ...(x.msg ? { message: x.msg } : {}), ...(x.word ? { word: x.word } : {}), ...w(x.author ?? x.by) })),
    where: Object.fromEntries(Object.entries(d.where ?? {}).map(([m, v]) => [m, { ...(v.branch ? { branch: v.branch } : {}), ...(v.head ? { head: v.head } : {}), ...(v.dirty !== undefined ? { dirty: v.dirty } : {}), ...(v.worktrees?.length ? { worktrees: v.worktrees } : {}), at: v.at.toISOString(), ...w(v.by) }])),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** An archived line as the State card shows it (the page only: the MCP State and the brief never carry archived lines). */
export type ArchivedOut = { id: string; text: string; from: 'Next' | 'Later'; waitsOn?: string; archivedAt: string; archivedBy: string; why?: string };

/** The newest 50 archived lines, newest first, with who archived them as a name. */
export function archivedOut(d: StateDoc, names: Names): ArchivedOut[] {
  return [...(d.archived ?? [])]
    .reverse()
    .slice(0, 50)
    .map(a => ({ id: a.id, text: a.text, from: a.from, ...(a.waitsOn ? { waitsOn: a.waitsOn } : {}), archivedAt: a.archivedAt.toISOString(), archivedBy: names[a.archivedBy] || 'a former member', ...(a.why ? { why: a.why } : {}) }));
}


/** One line of the copy: the file shows prefix + text + suffix; only text is the line's own words. */
export type CopyLine = { section: 'Now' | 'Next' | 'Later'; id?: string; line: string; prefix: string; text: string; suffix: string };

const waitSuffix = (l: StateLine) => (l.waitsOn && !l.text.toLowerCase().includes(l.waitsOn.toLowerCase()) ? ` \u2014 waits on ${l.waitsOn}` : '');

/** The Now, Next and Later lines of the copy, as the file shows them (no placeholder rows). */
export function copyLines(d: StateDoc): CopyLine[] {
  const out: CopyLine[] = [];
  const row = (section: CopyLine['section'], prefix: string, text: string, suffix: string, id?: string) => out.push({ section, ...(id ? { id } : {}), line: prefix + text + suffix, prefix, text, suffix });
  // No holder in the copy (Lanes): it would commit a new copy whenever the hold moves.
  if (d.now) row('Now', '- ', d.now.text, '');
  d.next.forEach((l, i) => row('Next', `${i + 1}. `, l.text, `${l.ref ? ` (#${l.ref})` : ''}${waitSuffix(l)}`, l.id));
  for (const l of d.later) row('Later', '- ', l.text, waitSuffix(l), l.id);
  return out;
}

/**
 * WORK-STATE.md as the repo copy of the State, headed with the version it came from. The same text for every reader (no
 * "(by X)"), so two PCs never commit different copies, and no Where (it changes with every session's head). Decisions are
 * listed only when `decisions` is true: leave them out for a public repo (lib/data/repo-visibility.ts).
 */
export function stateMarkdown(d: StateDoc, o: { projectName: string; url: string; names: Names; decisions?: boolean; /** Ignored: kept so older callers still compile. */ reader?: string }): string {
  const rows = copyLines(d);
  const out: string[] = [`Copy of the Work OS state, version ${d.version}. WORK-STATE.md is a copy of the State, written by the Work OS hook; never edit it. Change the State in Work OS (${o.url}).`, '', `# Work state: ${o.projectName}`, '', '## Now'];
  const now = rows.find(r => r.section === 'Now');
  out.push(now ? now.line : '- (nothing set)');
  out.push('', '## Next');
  const next = rows.filter(r => r.section === 'Next');
  if (next.length) for (const r of next) out.push(r.line);
  else out.push('- (empty)');
  out.push('', '## Later');
  const later = rows.filter(r => r.section === 'Later');
  if (later.length) for (const r of later) out.push(r.line);
  else out.push('- (empty)');
  const live = o.decisions ? d.decisions.filter(x => !x.archivedAt) : [];
  if (live.length) {
    out.push('', '## Decisions');
    for (const x of live.slice(-30)) out.push(`- ${x.at.toISOString().slice(0, 10)}: ${x.text} (${o.names[x.by] || 'a former member'}, ${x.via})`);
  }
  return out.join('\n') + '\n';
}

/** The copy of a project's State for a reader: the same text for everyone, Decisions only for a repo known to be private. */
export async function stateCopy(s: Scope, project: ProjectDoc, d: StateDoc, baseUrl: string): Promise<string> {
  const [names, decisions] = await Promise.all([memberNames(s.orgId), decisionsInCopy(s, project)]);
  return stateMarkdown(d, { projectName: project.name, url: `${baseUrl}/projects/${project._id}`, names, decisions });
}

/**
 * An Edit of one line of WORK-STATE.md, applied to the State. `oldText` and `newText` are one line each (an Edit of
 * several lines, the header, Decisions, or the number, task and waits-on marks is refused). `oldText` is text inside exactly
 * one Now, Next or Later line as the file shows it; an empty result removes the line (a Next line counts as done, so its
 * task finishes). It goes through saveState as an edit_line, so every rule of that op holds.
 */
export async function editCopyLine(s: Scope, projectKey: string, oldText: string, newText: string, o: { actor: Actor; via: Via }): Promise<SaveResult> {
  const one = (v: string) => v.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  const from = one(oldText);
  const to = one(newText);
  if (!from.trim()) throw new InputError('The Edit has no old text.');
  if (from.includes('\n') || to.includes('\n')) throw new InputError('Change one line at a time: an Edit of several lines of the WORK-STATE.md copy is not applied. Use save_state in Work OS (add_next, add_later, edit_line, done_next).');
  const { project, state } = await getState(s, projectKey);
  if (!state) throw new InputError('The project has no State yet.');
  const hits = copyLines(state).filter(r => r.line.includes(from));
  if (hits.length !== 1) {
    if (!hits.length) throw new InputError("No Now, Next or Later line holds that text. The copy's header and Decisions are not edited here; add a decision with save_state (add_decision), and add lines with add_next or add_later.");
    throw new InputError(`That text is in ${hits.length} lines (${hits.slice(0, 4).map(h => `"${h.line.length > 60 ? h.line.slice(0, 57) + '...' : h.line}"`).join(', ')}): use more of the line.`);
  }
  const hit = hits[0];
  if (hit.line.split(from).length > 2) throw new InputError('That text is in the line more than once: use more of the line.');
  const edited = hit.line.replace(from, () => to);
  let middle: string;
  if (!edited.trim() || edited.trim() === hit.prefix.trim()) middle = '';
  else if (edited.startsWith(hit.prefix) && edited.endsWith(hit.suffix) && edited.length >= hit.prefix.length + hit.suffix.length) middle = edited.slice(hit.prefix.length, edited.length - hit.suffix.length).trim();
  else throw new InputError('Change only the words of the line. The number, the task (#12) and the waits-on change with save_state.');
  // The version the line was found in: an edit of Now needs it (a newer State is a conflict, as for set_now); line edits ignore it.
  return saveState(s, project._id, [{ op: 'edit_line', find: hit.text, new: middle, ...(hit.id ? { id: hit.id } : {}) }], { actor: o.actor, via: o.via, baseVersion: state.version });
}
