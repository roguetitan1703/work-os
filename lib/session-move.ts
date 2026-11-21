// One session's work moves to another (plan note db5bf91389, piece B1). Used by the pickup (lib/data/pickup.ts), the close at
// sign-in (lib/agent-sessions.ts closeLeftBehind) and scripts/merge-dup-sessions.mjs, so all three move the same things the same way.
// Pure apart from the collections it is given: no imports (types inline), so the script loads it with type stripping.
// The collections are the app's (through the door, which adds the organization) or raw ones (the script: every id used here is unique).
//
// What a session holds, and where it is written (lib/db.ts):
//   needs         from.session / from.keyId (the asker) and handedTo (the answer was handed to it)       open, or answered and not yet briefed
//   messages      toSids (userId:key) it has not read, seenBy (the keys that read it)                       unread ones move; read ones stay read for the new key
//   states        now.hold.key, next[].hold.key, later[].hold.key; next[].src, later[].src                 userId:key
//   stateParked   src; tasks.src                                                                            userId:key, or a bare session id (the hook's State route)
//   slots         holds[].session and holds[].h (userId:session)
//   presence      parent (a builder row names its orchestrator's session id), doing
//   claudeItems   claimedBy.session
//   notes         handover.session, handover.pickedUp.session
// Nothing here bumps a State version.

type Res = { modifiedCount: number; matchedCount?: number };
type Col = {
  updateOne(filter: object, update: object, options?: object): Promise<Res>;
  updateMany(filter: object, update: object, options?: object): Promise<Res>;
  findOne(filter: object, options?: object): Promise<unknown>;
};
export type MoveCols = { needs: Col; messages: Col; states: Col; stateParked: Col; tasks: Col; slots: Col; presence: Col; claudeItems: Col; notes: Col };

/** The part of a presence row the move reads. `key` is the bare key (the session id, else the key id); messages and holds name it `userId:key`. */
export type MoveRow = { _id: string; userId: string; key: string; session?: string; keyId?: string; label?: string; doing?: { taskId: string; at: Date }; movedTo?: string; endedAt?: Date };

export type MovedWork = { needs: number; messages: number; seen: number; lines: number; now: boolean; slots: number; parents: number; claims: number; handovers: number; doing: boolean };

const fullKey = (r: Pick<MoveRow, 'userId' | 'key'>) => `${r.userId}:${r.key}`;

/**
 * Needs and unread messages of `from` go to `to` (same person only; the callers decide whether to). Needs: open, or answered and not
 * yet briefed, asked by `from` (its session id and key id) or handed to its session; rewritten to `to` so `to` is handed the answers and
 * may withdraw them. Messages: addressed to `from`'s key and not read by it, not sent by `to`, readdressed to `to`'s key (a message `to`
 * sent to `from` stays as it is). Messages `from` has read are marked read by `to`'s key too, so mail that was read stays read.
 */
export async function moveOwnedWork(cols: Pick<MoveCols, 'needs' | 'messages'>, projectId: string, from: MoveRow, to: MoveRow): Promise<{ needs: number; messages: number; seen: number }> {
  if (from.userId !== to.userId) return { needs: 0, messages: 0, seen: 0 };
  let needs = 0;
  if (from.session && to.session) {
    const open = [{ status: 'open' }, { status: 'answered', briefedAt: { $exists: false } }];
    const set: Record<string, unknown> = { 'from.session': to.session };
    const unset: Record<string, ''> = {};
    if (to.keyId) set['from.keyId'] = to.keyId;
    else unset['from.keyId'] = '';
    const mine = await cols.needs.updateMany(
      { projectId, 'from.actor.userId': from.userId, 'from.session': from.session, ...(from.keyId ? { 'from.keyId': from.keyId } : { 'from.keyId': { $exists: false } }), $or: open },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    );
    needs = mine.modifiedCount;
    // An answer handed to the old session (it was off when the answer came) is handed to the new one.
    const handed = await cols.needs.updateMany({ projectId, 'from.actor.userId': from.userId, handedTo: from.session, status: 'answered', briefedAt: { $exists: false } }, { $set: { handedTo: to.session } });
    needs += handed.modifiedCount;
  }
  const fk = fullKey(from);
  const tk = fullKey(to);
  // Both forms of "unread by from": a seenBy list without it, or (messages from before per-session read state) none and the status still unread.
  const unreadByFrom = [{ seenBy: { $exists: true, $nin: [fk] }, status: { $in: ['unread', 'seen'] } }, { seenBy: { $exists: false }, status: 'unread' }];
  const m = await cols.messages.updateMany({ projectId, toSids: fk, src: { $ne: tk }, $or: unreadByFrom }, { $set: { 'toSids.$[e]': tk } }, { arrayFilters: [{ e: fk }] });
  // Read by the old key: read by the new one too (at most 50 keys, as everywhere seenBy is written).
  const seen = await cols.messages.updateMany({ projectId, seenBy: { $in: [fk], $nin: [tk] } }, { $push: { seenBy: { $each: [tk], $slice: -50 } } });
  return { needs, messages: m.modifiedCount, seen: seen.modifiedCount };
}

/**
 * The Now hold and the held Next and Later lines of `from` go to `to` (a direct update on the State by arrayFilters, no version bump).
 * `ref`: a line on that task with no hold of its own passes too (what `from` was doing).
 */
export async function moveHolds(
  cols: Pick<MoveCols, 'states'>,
  projectId: string,
  st: { now?: { hold?: { key: string } } | null; next?: { id: string; ref?: number; hold?: { key: string } }[]; later?: { id: string; ref?: number; hold?: { key: string } }[] } | null,
  from: MoveRow,
  to: MoveRow,
  at: Date,
  o: { ref?: number; label?: string } = {},
): Promise<{ lines: number; now: boolean }> {
  const hk = fullKey(from);
  const tk = fullKey(to);
  let lines = 0;
  let nowMoved = false;
  if (!st) return { lines, now: nowMoved };
  if (st.now?.hold?.key === hk) {
    const r = await cols.states.updateOne({ _id: projectId, 'now.hold.key': hk }, { $set: { 'now.hold': { key: tk, label: o.label ?? '', at } } });
    nowMoved = r.modifiedCount > 0;
  }
  for (const list of ['next', 'later'] as const) {
    for (const l of st[list] ?? []) {
      if (!(l.hold?.key === hk || (!l.hold && o.ref != null && l.ref === o.ref))) continue;
      const r = await cols.states.updateOne({ _id: projectId }, { $set: { [`${list}.$[l].hold`]: { key: tk, at } } }, { arrayFilters: [{ 'l.id': l.id }] });
      if (r.modifiedCount) lines++;
    }
  }
  return { lines, now: nowMoved };
}

/**
 * Everything `from` holds on one project goes to `to` (the same person's two rows of one Claude session): Needs and unread messages,
 * the holds, the writer mark (src) on lines, parked lines and tasks, slot holds, builders' `parent`, claimed items, handovers and
 * what it is doing. Then the old row is marked ended and moved (`endedAt`, `movedTo` = `to`'s bare key, `swept`), so a reply to its
 * key follows to `to`. The callers decide whether the move may happen at all (never a busy row). Moves nothing between two people.
 * Every update matches only what names `from`, so a second run finds nothing.
 */
export async function moveSessionWork(cols: MoveCols, projectId: string, from: MoveRow, to: MoveRow, now: number = Date.now()): Promise<MovedWork> {
  const out: MovedWork = { needs: 0, messages: 0, seen: 0, lines: 0, now: false, slots: 0, parents: 0, claims: 0, handovers: 0, doing: false };
  if (from._id === to._id || from.userId !== to.userId) return out;
  const at = new Date(now);
  const owned = await moveOwnedWork(cols, projectId, from, to);
  Object.assign(out, owned);
  const st = (await cols.states.findOne({ _id: projectId }, { projection: { now: 1, next: 1, later: 1 } })) as Parameters<typeof moveHolds>[2];
  const held = await moveHolds(cols, projectId, st, from, to, at, { label: to.label });
  out.lines = held.lines;
  out.now = held.now;
  // The writer mark: `userId:key` (an MCP call) or the bare session id (the hook's State route); each keeps its own form.
  const fk = fullKey(from);
  const tk = fullKey(to);
  const forms: [string, string][] = [[fk, tk], ...(from.key !== fk ? ([[from.key, to.key]] as [string, string][]) : [])];
  for (const [a, b] of forms) {
    for (const list of ['next', 'later'] as const) await cols.states.updateOne({ _id: projectId, [`${list}.src`]: a }, { $set: { [`${list}.$[l].src`]: b } }, { arrayFilters: [{ 'l.src': a }] });
    await cols.stateParked.updateMany({ projectId, src: a }, { $set: { src: b } });
    await cols.tasks.updateMany({ projectId, src: a }, { $set: { src: b } });
  }
  if (from.session && to.session) {
    const sl = await cols.slots.updateMany({ holds: { $elemMatch: { session: from.session, userId: from.userId } } }, { $set: { 'holds.$[e].session': to.session, 'holds.$[e].h': tk } }, { arrayFilters: [{ 'e.session': from.session, 'e.userId': from.userId }] });
    out.slots = sl.modifiedCount;
    const pa = await cols.presence.updateMany({ userId: from.userId, parent: from.session }, { $set: { parent: to.session } });
    out.parents = pa.modifiedCount;
    const cl = await cols.claudeItems.updateMany({ projectId, 'claimedBy.session': from.session }, { $set: { 'claimedBy.session': to.session } });
    out.claims = cl.modifiedCount;
    const h1 = await cols.notes.updateMany({ 'handover.by': from.userId, 'handover.session': from.session }, { $set: { 'handover.session': to.session } });
    const h2 = await cols.notes.updateMany({ 'handover.pickedUp.session': from.session, 'handover.pickedUp.by': from.userId }, { $set: { 'handover.pickedUp.session': to.session } });
    out.handovers = h1.modifiedCount + h2.modifiedCount;
  }
  // What it was doing goes with the work, unless the taking row has something of its own (or does not exist yet: then it stays on the old row).
  if (from.doing) {
    const r = await cols.presence.updateOne({ _id: to._id, doing: { $exists: false } }, { $set: { doing: from.doing } });
    if (r.matchedCount ? r.matchedCount > 0 : r.modifiedCount > 0) {
      await cols.presence.updateOne({ _id: from._id }, { $unset: { doing: '' } });
      out.doing = true;
    }
  }
  await cols.presence.updateOne({ _id: from._id }, { $set: { movedTo: to.key, swept: at, ...(from.endedAt ? {} : { endedAt: at }) } });
  return out;
}
