import 'server-only';
import type { SlotDoc } from '../db';
import { scoped, type Scope } from '../scope';
import type { Ident } from './presence';

// Heavy slots (docs/flows/plan-1-3.md slice 7): a builds-and-tests session asks for a heavy slot on its machine before
// it starts a build, a test run or a browser, so a computer is never asked to run more at once than it can bear. At most
// `cap` (default 2) holders per machine, counted across every session on it. A hold is a 30-minute lease: a session that
// disappears frees its slot by itself; one still working renews it by asking again.
//
// One document per machine holds the leases, and every change is a single-document update with its condition in the
// filter, so concurrent requests can never put more holders in than the cap (no pipeline update needed: the door forbids
// them). The machine is the device id when the name resolved to one of the person's computers (lib/data/presence.ts
// resolveMachine), else the name the caller reported, kept apart per person (two people who both call theirs "laptop" are
// two machines). The document records its person (`ownerId`) and every write filters on it, so only that person changes
// it; it is read org-wide only to show "2 of 2" next to a worker. A document untouched for a day is removed (TTL).

export const LEASE_MS = 30 * 60_000;
export const DEFAULT_CAP = 2;
export const MAX_WAIT_S = 20;
export const POLL_MS = 2000;

/** The machine's key: its device id, or the reported name scoped to the person. */
export const machineKey = (userId: string, r: { machine: string; machineName?: string }): string => (r.machineName ? r.machine : `u:${userId}:${r.machine.toLowerCase()}`);

type Holder = { h: string; session: string; userId: string };
/** Who holds: the session id when there is one, else the key. */
export const holderOf = (i: Ident): Holder => {
  const session = i.session ?? `k:${i.keyId ?? i.agent}`;
  return { h: `${i.userId}:${session}`, session, userId: i.userId };
};

export type SlotAnswer = { acquired: boolean; machine: string; cap: number; held: number; holders: { session: string; minutesLeft: number }[]; /** When full: seconds until the earliest lease ends (retry then, or after a release). */ retryAfterSeconds?: number };

const docId = (s: Scope, key: string) => `${s.orgId}:${key}`;
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

/** Makes sure the document exists and drops leases that ended. Once per request, not once per poll. Returns the cap. */
export async function prepareSlot(s: Scope, key: string): Promise<number> {
  const c = await scoped(s);
  const _id = docId(s, key);
  const now = new Date();
  let doc = await c.slots.findOne({ _id });
  if (!doc) {
    try {
      await c.slots.insertOne({ _id, machine: key, kind: 'heavy', ownerId: s.userId, touchedAt: now, holds: [] } as unknown as SlotDoc); // the door stamps orgId
    } catch (e) {
      if (!isDup(e)) throw e; // another request created it first
    }
    doc = await c.slots.findOne({ _id });
  }
  // Another person's document is not ours to change (a plain-name key carries the person's id, a device id only resolves for its owner).
  if (!doc || doc.ownerId !== s.userId) return 0;
  await c.slots.updateOne({ _id, ownerId: s.userId }, { $pull: { holds: { until: { $lte: now } } } });
  return Math.max(1, doc.cap ?? DEFAULT_CAP);
}

function answer(d: SlotDoc | null, key: string, acquired: boolean, now: number): SlotAnswer {
  const holds = (d?.holds ?? []).filter(x => x.until.getTime() > now);
  const cap = d?.cap ?? DEFAULT_CAP;
  const earliest = holds.length ? Math.min(...holds.map(x => x.until.getTime())) : now;
  return {
    acquired,
    machine: key,
    cap,
    held: holds.length,
    holders: holds.map(x => ({ session: x.session, minutesLeft: Math.max(0, Math.ceil((x.until.getTime() - now) / 60_000)) })),
    ...(!acquired && holds.length >= cap ? { retryAfterSeconds: Math.max(1, Math.ceil((earliest - now) / 1000)) } : {}),
  };
}

/** One attempt (after prepareSlot). Never holds more than the cap, however many ask at once. */
export async function tryAcquire(s: Scope, key: string, holder: Holder, cap: number): Promise<SlotAnswer> {
  const c = await scoped(s);
  const _id = docId(s, key);
  if (cap < 1) return answer(null, key, false, Date.now()); // not this person's machine
  const attempt = async () => {
    const until = new Date(Date.now() + LEASE_MS);
    // Already held by this session: renew.
    const renewed = await c.slots.updateOne({ _id, ownerId: s.userId, holds: { $elemMatch: { h: holder.h, userId: holder.userId } } }, { $set: { 'holds.$.until': until, touchedAt: new Date() } });
    if (renewed.matchedCount > 0) return true;
    // "not already a holder" and "fewer than cap holds" (holds.<cap-1> does not exist): one atomic check-and-add.
    const r = await c.slots.updateOne(
      { _id, ownerId: s.userId, 'holds.h': { $ne: holder.h }, [`holds.${cap - 1}`]: { $exists: false } },
      { $push: { holds: { h: holder.h, session: holder.session, userId: holder.userId, until } }, $set: { touchedAt: new Date() } },
    );
    return r.matchedCount > 0;
  };
  let acquired = await attempt();
  let doc = await c.slots.findOne({ _id });
  // Full only because leases ended while we waited: drop them and try once more.
  if (!acquired && doc && doc.holds.length >= cap && doc.holds.some(x => x.until.getTime() <= Date.now())) {
    await c.slots.updateOne({ _id, ownerId: s.userId }, { $pull: { holds: { until: { $lte: new Date() } } } });
    acquired = await attempt();
    doc = await c.slots.findOne({ _id });
  }
  return answer(doc, key, acquired, Date.now());
}

/** Takes (or renews) a heavy slot. */
export async function acquireSlot(s: Scope, key: string, holder: Holder): Promise<SlotAnswer> {
  return tryAcquire(s, key, holder, await prepareSlot(s, key));
}

/** Gives a slot back (only the holder's own: the person is part of the hold). */
export async function releaseSlot(s: Scope, key: string, holder: Holder): Promise<SlotAnswer & { released: boolean }> {
  const c = await scoped(s);
  const _id = docId(s, key);
  // Only a hold of this person and session is removed; the filter on the hold makes 'nothing held' a no-match, not a change.
  const r = await c.slots.updateOne({ _id, ownerId: s.userId, holds: { $elemMatch: { h: holder.h, userId: holder.userId } } }, { $pull: { holds: { h: holder.h, userId: holder.userId } }, $set: { touchedAt: new Date() } });
  return { ...answer(await c.slots.findOne({ _id }), key, false, Date.now()), released: r.modifiedCount > 0 };
}

/** How full each machine is, for the screen: live leases per machine (read org-wide, like the workers shown beside them). */
export async function slotHolders(s: Scope, keys: string[]): Promise<Map<string, { held: number; cap: number }>> {
  const out = new Map<string, { held: number; cap: number }>();
  if (!keys.length) return out;
  const now = Date.now();
  const docs = await (await scoped(s)).slots.find({ _id: { $in: keys.map(k => docId(s, k)) } }, { projection: { machine: 1, cap: 1, holds: 1 } }).toArray();
  for (const d of docs) out.set(d.machine, { held: d.holds.filter(x => x.until.getTime() > now).length, cap: d.cap ?? DEFAULT_CAP });
  return out;
}
