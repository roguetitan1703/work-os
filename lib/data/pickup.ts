import 'server-only';
import type { PresenceDoc, StateLine } from '../db';
import { scoped, type Scope } from '../scope';
import { busy } from './lanes';
import { rowKey } from './presence';
import { GONE_MIN, presenceState } from './presence-state';

// Pickup and sweep (Lanes step 2, plan note 666b20a6e9). What a session holds when it stops (its Needs, its unread messages, the
// Now hold, its held lines, what it is doing) is moved to the session that takes over:
//   pickup  moveSession: a session picks up a handover; the old session's work moves to it (only if the old one ended or is not busy).
//   sweep   sweepGone: a session off for 30 minutes or more hands its Needs and messages to the Now holder (else the person's
//           newest live session) and its held lines are released with a `left` record. Runs from deliverFor (turn mode).
// Needs and messages move only between sessions of one person (a Need's from.session and from.keyId, a message's toSids).
// Every read and write goes through the caller's door (`scoped(s)`) on the one project; nothing here bumps the State version.

const MAX_HOPS = 3;

/** How a presence row names a session in messages (userId:key). */
const keyOf = (r: Pick<PresenceDoc, 'userId' | 'key'>) => rowKey(r);

export type Moved = { needs: number; messages: number; lines: number; now: boolean };
export type MoveResult = ({ moved: true } & Moved) | { moved: false; reason: 'busy' | 'self' | 'project' | 'already moved' };

type Coll = Awaited<ReturnType<typeof scoped>>;

/**
 * Moves the Needs and unread messages of one session to another (same person only; no other checks: the callers decide).
 * Needs: open and answered-and-not-yet-handed-over ones asked by `from` (its session id and its key), rewritten to `to`'s session
 * and key so that `to` is handed the answers and may withdraw them. Messages: those addressed to `from`'s key and not read by it,
 * readdressed to `to`'s key.
 */
async function moveOwned(c: Coll, projectId: string, from: PresenceDoc, to: PresenceDoc): Promise<{ needs: number; messages: number }> {
  if (from.userId !== to.userId) return { needs: 0, messages: 0 };
  let needs = 0;
  if (from.session && to.session) {
    const q = {
      projectId,
      'from.actor.userId': from.userId,
      'from.session': from.session,
      ...(from.keyId ? { 'from.keyId': from.keyId } : { 'from.keyId': { $exists: false } }),
      $or: [{ status: 'open' }, { status: 'answered', briefedAt: { $exists: false } }],
    };
    const set: Record<string, unknown> = { 'from.session': to.session };
    const unset: Record<string, ''> = {};
    if (to.keyId) set['from.keyId'] = to.keyId;
    else unset['from.keyId'] = '';
    const r = await c.needs.updateMany(q as never, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) } as never);
    needs = r.modifiedCount;
  }
  // Messages: addressed to A, unread by A (seenBy is the list of keys that read it), not sent by B (a message B sent to A stays as it is).
  const fk = keyOf(from);
  const tk = keyOf(to);
  // Both forms of "unread by A": a seenBy list without A, or (messages from before per-session read state) none and the status still unread.
  const unreadByA = [{ seenBy: { $exists: true, $nin: [fk] }, status: { $in: ['unread', 'seen'] } }, { seenBy: { $exists: false }, status: 'unread' }];
  const r = await c.messages.updateMany({ projectId, toSids: fk, src: { $ne: tk }, $or: unreadByA } as never, { $set: { 'toSids.$[e]': tk } } as never, { arrayFilters: [{ e: fk }] } as never);
  return { needs, messages: r.modifiedCount };
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
export async function moveSession(s: Scope, projectId: string, from: PresenceDoc, to: PresenceDoc, now: number = Date.now()): Promise<MoveResult> {
  if (from._id === to._id) return { moved: false, reason: 'self' };
  if (from.projectId !== projectId || to.projectId !== projectId) return { moved: false, reason: 'project' };
  if (busy(from, now)) return { moved: false, reason: 'busy' };
  if (from.movedTo && from.movedTo !== to.key) return { moved: false, reason: 'already moved' };
  if (to.movedTo === from.key) return { moved: false, reason: 'already moved' };
  const c = await scoped(s);
  const same = from.userId === to.userId;
  const owned = await moveOwned(c, projectId, from, to);
  const at = new Date(now);
  // Now hold and held lines. A line whose task is the one `from` was on (and no other hold) passes too.
  const ref = await doingRef(c, from);
  let lines = 0;
  let nowMoved = false;
  const st = await c.states.findOne({ _id: projectId }, { projection: { now: 1, next: 1, later: 1 } });
  if (st) {
    if (st.now?.hold?.key === from.key) {
      const r = await c.states.updateOne({ _id: projectId, 'now.hold.key': from.key } as never, { $set: { 'now.hold': { key: to.key, label: to.label ?? '', at } } } as never);
      nowMoved = r.modifiedCount > 0;
    }
    const mine = (l: StateLine) => l.hold?.key === from.key || (!l.hold && ref != null && l.ref === ref);
    for (const list of ['next', 'later'] as const) {
      for (const l of st[list] ?? []) {
        if (!mine(l)) continue;
        const r = await c.states.updateOne({ _id: projectId } as never, { $set: { [`${list}.$[l].hold`]: { key: to.key, at } } } as never, { arrayFilters: [{ 'l.id': l.id }] } as never);
        if (r.modifiedCount) lines++;
      }
    }
  }
  // What it was doing goes with the work (unless the taking session is on something of its own).
  if (from.doing && same) {
    if (!to.doing) await c.presence.updateOne({ _id: to._id }, { $set: { doing: from.doing } });
    await c.presence.updateOne({ _id: from._id }, { $unset: { doing: '' } });
  }
  if (same) await c.presence.updateOne({ _id: from._id }, { $set: { movedTo: to.key } });
  return { moved: true, needs: owned.needs, messages: owned.messages, lines, now: nowMoved };
}

/**
 * Where a reply to a session of one person goes now: its key (`userId:key`) followed along `movedTo` at most 3 hops. Same person
 * all the way (movedTo is only set between sessions of one person). Never throws: a missing row ends the chain.
 */
export async function followMoved(s: Scope, projectId: string | null, key: string): Promise<string> {
  const i = key.indexOf(':');
  if (i < 1) return key;
  const userId = key.slice(0, i);
  const c = await scoped(s);
  let cur = key.slice(i + 1);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const row = await c.presence.findOne({ projectId, userId, key: cur }, { projection: { movedTo: 1 } });
    if (!row?.movedTo || row.movedTo === cur) break;
    cur = row.movedTo;
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
async function leftOf(c: Coll, row: PresenceDoc, line: StateLine, where: Record<string, { branch?: string; head?: string }>, at: Date): Promise<NonNullable<StateLine['left']>> {
  let log: string | undefined;
  if (line.ref != null) {
    const a = await c.activity.find({ taskRef: line.ref, note: { $exists: true } } as never).sort({ at: -1 }).limit(1).next();
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
    .find({ projectId, userId: s.userId, _id: { $ne: selfRowId }, lastSeen: { $lt: cutoff }, $or: [{ swept: { $exists: false } }, { $expr: { $lt: ['$swept', '$lastSeen'] } }] } as never)
    .sort({ lastSeen: -1 })
    .limit(20)
    .toArray()).filter(r => goneFor30(r, now));
  if (!cands.length) return out;
  const st = await c.states.findOne({ _id: projectId }, { projection: { now: 1, next: 1, later: 1, where: 1 } });
  const live = (await c.presence.find({ projectId, userId: s.userId, lastSeen: { $gte: cutoff } } as never).sort({ lastSeen: -1 }).limit(20).toArray()).filter(r => presenceState(r, { now }).state !== 'off');
  const holderKey = st?.now?.hold?.key;
  const holder = holderKey ? live.find(r => r.key === holderKey) : undefined;
  const at = new Date(now);
  for (const a of cands) {
    const target = (holder && holder._id !== a._id ? holder : undefined) ?? live.find(r => r._id !== a._id);
    if (!target) continue;
    const moved = await moveOwned(c, projectId, a, target);
    out.needs += moved.needs;
    out.messages += moved.messages;
    // Held lines are released: the hold goes, a `left` record stays on the line.
    for (const list of ['next', 'later'] as const) {
      for (const l of st?.[list] ?? []) {
        if (l.hold?.key !== a.key) continue;
        const left = await leftOf(c, a, l, st?.where ?? {}, at);
        const r = await c.states.updateOne({ _id: projectId } as never, { $set: { [`${list}.$[l].left`]: left }, $unset: { [`${list}.$[l].hold`]: '' } } as never, { arrayFilters: [{ 'l.id': l.id, 'l.hold.key': a.key }] } as never);
        if (r.modifiedCount) out.lines++;
      }
    }
    await c.presence.updateOne({ _id: a._id }, { $set: { swept: at } });
    out.rows++;
  }
  return out;
}
