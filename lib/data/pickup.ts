import 'server-only';
import type { PresenceDoc, StateLine } from '../db';
import { scoped, type Scope } from '../scope';
import { busy } from './lanes';
import { rowKey } from './presence';
import { GONE_MIN, presenceState } from './presence-state';
import { moveHolds, moveOwnedWork } from '../session-move';

// Pickup and sweep (Lanes step 2, plan note 666b20a6e9). What a session holds when it stops (its Needs, its unread messages, the
// Now hold, its held lines, what it is doing) is moved to the session that takes over:
//   pickup  moveSession: a session picks up a handover; the old session's work moves to it (only if the old one ended or is not busy).
//   sweep   sweepGone: a session off for 30 minutes or more hands its Needs and messages to the Now holder (else the person's
//           newest live session) and its held lines are released with a `left` record. Runs from deliverFor (turn mode).
// Needs and messages move only between sessions of one person (a Need's from.session and from.keyId, a message's toSids).
// Every read and write goes through the caller's door (`scoped(s)`) on the one project; nothing here bumps the State version.

const MAX_HOPS = 3;
/** At most this many rows are swept per call (the sweep runs inside the 3-second prompt hook). */
const SWEEP_ROWS = 3;

/** How a presence row names a session in messages (userId:key). */
const keyOf = (r: Pick<PresenceDoc, 'userId' | 'key'>) => rowKey(r);
/** A hold names a session by userId:key (a row without a session is keyed by its agent name, which two people may share). */
const holdKey = keyOf;
/** A handover older than this no longer moves holds (an idle but live session may still hold Now). */
const HOLD_MOVE_MAX_MS = 24 * 3_600_000;

export type Moved = { needs: number; messages: number; lines: number; now: boolean };
export type MoveResult = ({ moved: true } & Moved) | { moved: false; reason: 'busy' | 'self' | 'project' | 'already moved' };

type Coll = Awaited<ReturnType<typeof scoped>>;

/**
 * Moves the Needs and unread messages of one session to another (same person only; no other checks: the callers decide): the shared
 * move in lib/session-move.ts (Needs asked by or handed to `from`, unread messages, read mail marked read for `to`).
 */
async function moveOwned(c: Coll, projectId: string, from: PresenceDoc, to: PresenceDoc): Promise<{ needs: number; messages: number }> {
  const r = await moveOwnedWork(c as never, projectId, from, to);
  return { needs: r.needs, messages: r.messages };
}

/** A line's task ref the session says it is on (set_doing), resolved through the caller's door. */
async function doingRef(c: Coll, row: PresenceDoc): Promise<number | undefined> {
  if (!row.doing) return undefined;
  const t = await c.tasks.findOne({ _id: row.doing.taskId }, { projection: { ref: 1 } });
  return t?.ref;
}

/**
 * The session `from` hands its work to `to` on one project (a pickup). Only when `from` has ended or is not busy (working, or at a
 * permission prompt: lanes.ts busy). Moves Needs and unread messages (same person only), the Now hold, held lines and what it is doing
 * (a direct update on the State by arrayFilters, no version bump), and sets `movedTo` on `from` (same person only: replies follow it).
 */
export async function moveSession(s: Scope, projectId: string, from: PresenceDoc, to: PresenceDoc, now: number = Date.now(), o: { /** When the handover was written: holds move only for a handover younger than 24 hours. */ handoverAt?: Date } = {}): Promise<MoveResult> {
  if (from._id === to._id) return { moved: false, reason: 'self' };
  if (from.projectId !== projectId || to.projectId !== projectId) return { moved: false, reason: 'project' };
  if (busy(from, now)) return { moved: false, reason: 'busy' };
  if (from.movedTo && from.movedTo !== to.key && !from.swept) return { moved: false, reason: 'already moved' };
  if (to.movedTo === from.key) return { moved: false, reason: 'already moved' };
  const c = await scoped(s);
  const same = from.userId === to.userId;
  const owned = await moveOwned(c, projectId, from, to);
  const at = new Date(now);
  // Now hold and held lines. A line whose task is the one `from` was on (and no other hold) passes too.
  const ref = await doingRef(c, from);
  const fresh = !o.handoverAt || now - o.handoverAt.getTime() < HOLD_MOVE_MAX_MS;
  const st = fresh ? await c.states.findOne({ _id: projectId }, { projection: { now: 1, next: 1, later: 1 } }) : null;
  const held = await moveHolds(c as never, projectId, st as never, from, to, at, { ref, label: to.label ?? '' });
  const lines = held.lines;
  const nowMoved = held.now;
  // What it was doing goes with the work (unless the taking session is on something of its own).
  if (from.doing && same) {
    if (!to.doing) await c.presence.updateOne({ _id: to._id }, { $set: { doing: from.doing } });
    await c.presence.updateOne({ _id: from._id }, { $unset: { doing: '' } });
  }
  if (same) await c.presence.updateOne({ _id: from._id }, { $set: { movedTo: to.key } });
  return { moved: true, needs: owned.needs, messages: owned.messages, lines, now: nowMoved };
}

/** The session a gone session's work goes to: the Now holder when it is live (and not `excludeId`), else the newest live session. `live` is newest first. */
function pickTarget(live: PresenceDoc[], holder: string | undefined, excludeId: string): PresenceDoc | null {
  const h = holder ? live.find(r => holdKey(r) === holder && r._id !== excludeId) : undefined;
  return h ?? live.find(r => r._id !== excludeId) ?? null;
}

/**
 * A claude.ai chat's row (OAuth, no session id: its connector is its session). A chat is never swept, never followed past and never takes
 * another session's work: it may be quiet for hours and still be the one to answer, and what is sent to it (a reply) must reach it.
 */
export const isChatRow = (r: Pick<PresenceDoc, 'session' | 'keyId'>): boolean => !r.session && !!r.keyId?.startsWith('oauth_');

async function liveRows(c: Coll, projectId: string, userId: string, now: number): Promise<PresenceDoc[]> {
  const cutoff = new Date(now - GONE_MIN * 60_000);
  return (await c.presence.find({ projectId, userId, lastSeen: { $gte: cutoff } } as never).sort({ lastSeen: -1 }).limit(20).toArray()).filter(r => !isChatRow(r) && presenceState(r, { now }).state !== 'off');
}

/**
 * Where a reply to a session of the caller goes now: its key (`userId:key`) followed along `movedTo` at most 3 hops, same person
 * all the way. A row that is alive again is not followed past (it came back). If the chain ends on a dead row, the reply goes where the
 * sweep would send that row's work (the Now holder when live, else the newest live session). Never throws: a missing row ends the chain.
 */
export async function followMoved(s: Scope, projectId: string | null, key: string, now: number = Date.now()): Promise<string> {
  const i = key.indexOf(':');
  if (i < 1 || key.slice(0, i) !== s.userId) return key;
  const userId = key.slice(0, i);
  const c = await scoped(s);
  let cur = key.slice(i + 1);
  let row: PresenceDoc | null = null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    row = await c.presence.findOne({ projectId, userId, key: cur });
    if (hop === MAX_HOPS || !row?.movedTo || row.movedTo === cur || presenceState(row, { now }).state !== 'off') break;
    cur = row.movedTo;
  }
  if (projectId && row && !isChatRow(row) && presenceState(row, { now }).state === 'off') {
    const st = await c.states.findOne({ _id: projectId }, { projection: { now: 1 } });
    const t = pickTarget(await liveRows(c, projectId, userId, now), st?.now?.hold?.key, row._id);
    if (t) return holdKey(t);
  }
  return `${userId}:${cur}`;
}

/** A row that has been quiet (no event, no call, not ended later) for GONE_MIN minutes or more and is off. */
function goneFor30(r: PresenceDoc, now: number): boolean {
  if (presenceState(r, { now }).state !== 'off') return false;
  const last = Math.max(r.lastSeen.getTime(), r.activity?.at.getTime() ?? 0, r.endedAt?.getTime() ?? 0);
  return (now - last) / 60_000 >= GONE_MIN;
}

/** The text a released line keeps: where the session stood. */
async function leftOf(c: Coll, projectId: string, row: PresenceDoc, line: StateLine, where: Record<string, { branch?: string; head?: string }>, at: Date): Promise<NonNullable<StateLine['left']>> {
  let log: string | undefined;
  if (line.ref != null) {
    // The task is looked up inside the line's own project first (a ref in another project, maybe private, gives nothing), then its log by task id.
    const t = await c.tasks.findOne({ projectId, ref: line.ref }, { projection: { _id: 1 } });
    const a = t ? await c.activity.find({ taskId: t._id, note: { $exists: true } } as never).sort({ at: -1 }).limit(1).next() : null;
    if (a?.note) log = a.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  }
  const head = row.branch ? Object.values(where ?? {}).find(w => w.branch === row.branch)?.head : undefined;
  return { label: row.label || 'a session', ...(row.branch ? { branch: row.branch } : {}), ...(head ? { head } : {}), ...(log ? { log } : {}), at };
}

/**
 * The sweep (Lanes step 2, from deliverFor in turn mode): the caller's own rows on the project that have been off for 30 minutes or
 * more and are not swept hand their Needs and unread messages to the Now holder (when it is the same person's and live), else to the
 * person's newest live session; the lines they hold are released with a `left` record. Nothing moves to another person. A row is
 * swept again only after it was seen alive again. Never throws into the caller.
 */
export async function sweepGone(s: Scope, projectId: string, selfRowId: string, now: number = Date.now()): Promise<{ rows: number; needs: number; messages: number; lines: number }> {
  const out = { rows: 0, needs: 0, messages: 0, lines: 0 };
  const c = await scoped(s);
  const cutoff = new Date(now - GONE_MIN * 60_000);
  const cands = (await c.presence
    .find({ projectId, userId: s.userId, _id: { $ne: selfRowId }, lastSeen: { $lt: cutoff }, $nor: [{ session: { $exists: false }, keyId: { $regex: '^oauth_' } }], $or: [{ swept: { $exists: false } }, { $expr: { $lt: ['$swept', '$lastSeen'] } }] } as never)
    .sort({ lastSeen: -1 })
    .limit(20)
    .toArray()).filter(r => !isChatRow(r) && goneFor30(r, now)).slice(0, SWEEP_ROWS);
  if (!cands.length) return out;
  const st = await c.states.findOne({ _id: projectId }, { projection: { now: 1, next: 1, later: 1, where: 1 } });
  const live = await liveRows(c, projectId, s.userId, now);
  const at = new Date(now);
  for (const a of cands) {
    const target = pickTarget(live, st?.now?.hold?.key, a._id);
    if (!target) continue;
    const moved = await moveOwned(c, projectId, a, target);
    out.needs += moved.needs;
    out.messages += moved.messages;
    // Held lines are released: the hold goes, a `left` record stays on the line.
    for (const list of ['next', 'later'] as const) {
      for (const l of st?.[list] ?? []) {
        if (l.hold?.key !== holdKey(a)) continue;
        const left = await leftOf(c, projectId, a, l, st?.where ?? {}, at);
        const r = await c.states.updateOne({ _id: projectId } as never, { $set: { [`${list}.$[l].left`]: left }, $unset: { [`${list}.$[l].hold`]: '' } } as never, { arrayFilters: [{ 'l.id': l.id, 'l.hold.key': holdKey(a) }] } as never);
        if (r.modifiedCount) out.lines++;
      }
    }
    await c.presence.updateOne({ _id: a._id }, { $set: { swept: at, movedTo: target.key } });
    out.rows++;
  }
  return out;
}
