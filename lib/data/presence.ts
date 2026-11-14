import 'server-only';
import type { PresenceDoc, ProjectDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { placeIn } from './projects';

// Sessions working on a project (docs/flows/step-1.md section 5). A row per session, stamped with the project's placement
// (so the door shows it to the project's readers only, and the placement cascade moves it with the project) and kept
// out of the push-hint topics (lib/scope.ts TOPICS): a heartbeat refreshes nobody's page.
//
// Key of a row: the session id when the call carries one (the `session` argument or X-Work-OS-Session), else the key id
// (an OAuth client id is per client per person) plus the project. The person's id is part of the row id, so nobody can
// take over another person's row by sending their session id.

export const PRESENT_MIN = 30;
const REFRESH_MS = 60_000;

export type Ident = { userId: string; agent: string; keyId?: string; keyName?: string; session?: string };

const rowId = (i: Ident, projectId: string) => (i.session ? `${i.userId}:s:${i.session}` : `${i.userId}:k:${i.keyId ?? i.agent}:${projectId}`);

// "No row for this caller" is remembered for a few seconds, so a caller who never calls start_work costs no read per tool call.
const none = new Map<string, number>();
const NONE_MS = 15_000;
const noneKey = (i: Ident) => `${i.userId}|${i.session ?? ''}|${i.keyId ?? ''}`;

/** Registers (or refreshes) the session as present on a project. Called by start_work. */
export async function registerPresence(s: Scope, i: Ident, project: ProjectDoc, o: { machine?: string; label?: string }): Promise<PresenceDoc> {
  const c = await scoped(s);
  const now = new Date();
  const _id = rowId(i, project._id);
  await c.presence.updateOne(
    { _id },
    {
      $set: {
        projectId: project._id,
        userId: s.userId,
        key: i.session ?? i.keyId ?? i.agent,
        ...(i.session ? { session: i.session } : {}),
        ...(i.keyId ? { keyId: i.keyId } : {}),
        label: (o.label ?? '').slice(0, 120),
        machine: (o.machine ?? '').slice(0, 40),
        ai: (i.keyName || i.agent).slice(0, 80),
        agent: i.agent,
        lastSeen: now,
        // start_work hands over everything there is, so what is "new for you" starts here.
        forYouCursor: now,
        writesSinceSave: 0,
        ...placeIn(project, s.userId),
      },
    },
    { upsert: true },
  );
  for (const k of [...none.keys()]) if (k.startsWith(`${i.userId}|`)) none.delete(k);
  return (await c.presence.findOne({ _id }))!;
}

/** The present row of this caller (by session id, else the most recent one of their key), or null. */
export async function presentRow(s: Scope, i: Ident): Promise<PresenceDoc | null> {
  const nk = noneKey(i);
  const seen = none.get(nk);
  if (seen && Date.now() - seen < NONE_MS) return null;
  const c = await scoped(s);
  let row: PresenceDoc | null = null;
  if (i.session) row = await c.presence.findOne({ _id: `${i.userId}:s:${i.session}` });
  if (!row && i.keyId) row = await c.presence.findOne({ userId: i.userId, keyId: i.keyId, lastSeen: { $gt: new Date(Date.now() - PRESENT_MIN * 60_000) } }, { sort: { lastSeen: -1 } });
  if (!row) {
    if (none.size > 2000) none.clear();
    none.set(nk, Date.now());
  }
  return row;
}

/** Heartbeat: at most one write a minute per row. */
export async function touchPresence(s: Scope, row: PresenceDoc): Promise<void> {
  const now = Date.now();
  if (now - row.lastSeen.getTime() < REFRESH_MS) return;
  await (await scoped(s)).presence.updateOne({ _id: row._id, lastSeen: { $lt: new Date(now - REFRESH_MS) } }, { $set: { lastSeen: new Date(now) } });
}

/** Claims "what is new" for this session: moves the cursor from the value read to `to`. False if another call of the session took it first. */
export async function claimCursor(s: Scope, row: PresenceDoc, to: Date): Promise<boolean> {
  const r = await (await scoped(s)).presence.updateOne({ _id: row._id, forYouCursor: row.forYouCursor }, { $set: { forYouCursor: to } });
  return r.matchedCount > 0;
}

/** Counts a write of the session since its last save_state; returns the new count. */
export async function countWrite(s: Scope, row: PresenceDoc): Promise<number> {
  const r = await (await scoped(s)).presence.findOneAndUpdate({ _id: row._id }, { $inc: { writesSinceSave: 1 } }, { returnDocument: 'after', projection: { writesSinceSave: 1 } });
  return r?.writesSinceSave ?? row.writesSinceSave + 1;
}

export async function resetWrites(s: Scope, row: PresenceDoc): Promise<void> {
  await (await scoped(s)).presence.updateOne({ _id: row._id }, { $set: { writesSinceSave: 0 } });
}

/** Sessions seen in the last PRESENT_MIN minutes on a project, except one row. */
export async function othersPresent(s: Scope, projectId: string, exceptId?: string): Promise<PresenceDoc[]> {
  const c = await scoped(s);
  return c.presence
    .find({ projectId, lastSeen: { $gt: new Date(Date.now() - PRESENT_MIN * 60_000) }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .sort({ lastSeen: -1 })
    .limit(30)
    .toArray();
}
