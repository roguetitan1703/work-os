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
// two machines).

export const LEASE_MS = 30 * 60_000;
export const DEFAULT_CAP = 2;
export const MAX_WAIT_S = 20;

/** The machine's key: its device id, or the reported name scoped to the person. */
export const machineKey = (userId: string, r: { machine: string; machineName?: string }): string => (r.machineName ? r.machine : `u:${userId}:${r.machine.toLowerCase()}`);

/** Who holds: the session id when there is one, else the key. */
export const holderOf = (i: Ident): { h: string; session: string; userId: string } => {
  const session = i.session ?? `k:${i.keyId ?? i.agent}`;
  return { h: `${i.userId}:${session}`, session, userId: i.userId };
};

export type SlotAnswer = { acquired: boolean; machine: string; cap: number; held: number; holders: { session: string; minutesLeft: number }[]; /** When full: seconds until the earliest lease ends (retry then, or after a release). */ retryAfterSeconds?: number };

const docId = (s: Scope, key: string) => `${s.orgId}:${key}`;
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

async function ensure(s: Scope, key: string): Promise<SlotDoc> {
  const c = await scoped(s);
  const _id = docId(s, key);
  const have = await c.slots.findOne({ _id });
  if (have) return have;
  try {
    await c.slots.insertOne({ _id, machine: key, kind: 'heavy', holds: [] } as unknown as SlotDoc); // the door stamps orgId
  } catch (e) {
    if (!isDup(e)) throw e; // another request created it first
  }
  return (await c.slots.findOne({ _id }))!;
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

/** Takes (or renews) a heavy slot. Never holds more than the cap, however many ask at once. */
export async function acquireSlot(s: Scope, key: string, holder: { h: string; session: string; userId: string }): Promise<SlotAnswer> {
  const c = await scoped(s);
  const _id = docId(s, key);
  const doc = await ensure(s, key);
  const cap = Math.max(1, doc.cap ?? DEFAULT_CAP);
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  // Leases that ended free their place (idempotent, safe under concurrency).
  await c.slots.updateOne({ _id }, { $pull: { holds: { until: { $lte: now } } } });
  // Already held by this session: renew.
  const renewed = await c.slots.updateOne({ _id, 'holds.h': holder.h }, { $set: { 'holds.$.until': until } });
  let acquired = renewed.matchedCount > 0;
  if (!acquired) {
    // The filter says "not already a holder" and "fewer than cap holds" (holds.<cap-1> does not exist): one atomic check-and-add.
    const r = await c.slots.updateOne({ _id, 'holds.h': { $ne: holder.h }, [`holds.${cap - 1}`]: { $exists: false } }, { $push: { holds: { h: holder.h, session: holder.session, userId: holder.userId, until } } });
    acquired = r.matchedCount > 0;
  }
  return answer(await c.slots.findOne({ _id }), key, acquired, Date.now());
}

/** Gives a slot back. */
export async function releaseSlot(s: Scope, key: string, holder: { h: string }): Promise<SlotAnswer & { released: boolean }> {
  const c = await scoped(s);
  const _id = docId(s, key);
  const r = await c.slots.updateOne({ _id }, { $pull: { holds: { h: holder.h } } });
  return { ...answer(await c.slots.findOne({ _id }), key, false, Date.now()), released: r.modifiedCount > 0 };
}

/** Who holds what, for the screen: live leases per machine. */
export async function slotHolders(s: Scope, keys: string[]): Promise<Map<string, { held: number; cap: number }>> {
  const out = new Map<string, { held: number; cap: number }>();
  if (!keys.length) return out;
  const now = Date.now();
  const docs = await (await scoped(s)).slots.find({ _id: { $in: keys.map(k => docId(s, k)) } }).toArray();
  for (const d of docs) out.set(d.machine, { held: d.holds.filter(x => x.until.getTime() > now).length, cap: d.cap ?? DEFAULT_CAP });
  return out;
}
