import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { clientIp } from './auth';
import { getDb } from './db';
import { roleOf } from './caller';
import { seal, unseal } from './delpat-os';

// The private calendar link (docs/calendar.md): one token per person per organization, stored hashed (like API keys),
// kept sealed so its owner can copy it again. The feed route finds the person by the token alone; everything it then reads goes through the door.

type FeedDoc = { _id: string; orgId: string; userId: string; hash: string; /** The token sealed (AES-256-GCM, lib/delpat-os.ts seal: key from DELPAT_OS_TOKEN_KEY or derived from BETTER_AUTH_SECRET), so the owner can copy it again. */ sealed?: string; createdAt: Date; rotatedAt: Date | null };
type Who = { userId: string; orgId: string };

const coll = async () => (await getDb()).collection<FeedDoc>('calendarFeeds'); // scope-ok: the person's own link row, keyed by orgId:userId (calendar feed token)
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const aad = (s: Who) => `calendar:${s.orgId}:${s.userId}`;
const idOf = (s: Who) => `${s.orgId}:${s.userId}`;

/** 32 random bytes as base64url: always 43 characters of [A-Za-z0-9_-]. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type FeedStatus = { on: boolean; createdAt: string | null; rotatedAt: string | null };

export async function feedStatus(s: Who): Promise<FeedStatus> {
  const d = await (await coll()).findOne({ _id: idOf(s) });
  return { on: !!d, createdAt: d?.createdAt.toISOString() ?? null, rotatedAt: d?.rotatedAt?.toISOString() ?? null };
}

/** Makes the link (or replaces it: the old one stops at once). Returns the token, the only time it exists in full. */
export async function setFeed(s: Who): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const c = await coll();
  const had = await c.findOne({ _id: idOf(s) }, { projection: { _id: 1 } });
  await c.updateOne(
    { _id: idOf(s) },
    { $set: { orgId: s.orgId, userId: s.userId, hash: hashOf(token), sealed: seal(token, aad(s)), rotatedAt: had ? now : null }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return token;
}

/** The person's own token again (for Copy), or null when they have no link (or it predates sealing: rotate it). */
export async function readFeedToken(s: Who): Promise<string | null> {
  const d = await (await coll()).findOne({ _id: idOf(s) }, { projection: { sealed: 1 } });
  return d?.sealed ? unseal(d.sealed, aad(s)) : null;
}

/** Turns the link off. Returns whether there was one. */
export async function removeFeed(s: Who): Promise<boolean> {
  return (await (await coll()).deleteOne({ _id: idOf(s) })).deletedCount > 0;
}

/** Who a token belongs to, or null (malformed, unknown, rotated, turned off, or the person is no longer a member). */
export async function feedOwner(token: string): Promise<Who | null> {
  if (!TOKEN_RE.test(token)) return null;
  const d = await (await coll()).findOne({ hash: hashOf(token) });
  if (!d) return null;
  if (!(await roleOf(d.userId, d.orgId))) return null;
  return { userId: d.userId, orgId: d.orgId };
}

// Misses per client address (in memory per process, like /api/worker): over MAX_MISSES in a minute answers 429.
const MAX_MISSES = 20;
const misses = new Map<string, number[]>();
const bucket = (h: Headers) => clientIp(h) ?? 'shared';
const recent = (k: string, now: number) => (misses.get(k) ?? []).filter(t => now - t < 60_000);

export function tooManyMisses(h: Headers): boolean {
  return recent(bucket(h), Date.now()).length >= MAX_MISSES;
}

export function recordMiss(h: Headers): void {
  const now = Date.now();
  const k = bucket(h);
  const r = recent(k, now);
  r.push(now);
  misses.set(k, r);
  if (misses.size > 500) for (const [key, v] of misses) if (!v.some(t => now - t < 60_000)) misses.delete(key);
}
