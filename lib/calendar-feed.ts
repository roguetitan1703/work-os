import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { clientIp } from './auth';
import { getDb } from './db';
import { idIn } from './auth-server';
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
  // Membership read straight from the database (not the 60 s role cache): a removed member or deleted organization stops at once.
  const m = await (await getDb()).collection('member').findOne({ userId: idIn(d.userId), organizationId: idIn(d.orgId) }, { projection: { _id: 1 } }); // scope-ok: Better Auth member row, keyed by this link's own person and organization
  if (!m) return null;
  return { userId: d.userId, orgId: d.orgId };
}

// Misses per client address (in memory per process, like /api/worker): after MAX_MISSES wrong tokens in a minute, further wrong
// tokens answer 429. A valid token is never refused. Without TRUST_PROXY the address is unknown, so there is no limit
// (one shared bucket would let anyone lock everyone out; the token is 256 bits, so guessing is not the risk).
const MAX_MISSES = 20;
const misses = new Map<string, number[]>();
const recent = (k: string, now: number) => (misses.get(k) ?? []).filter(t => now - t < 60_000);

/** Records a wrong token from this client and says whether it has used up its misses (answer 429 instead of 404). */
export function recordMiss(h: Headers): boolean {
  const k = clientIp(h);
  if (!k) return false;
  const now = Date.now();
  const r = recent(k, now);
  const over = r.length >= MAX_MISSES;
  if (!over) r.push(now);
  misses.set(k, r);
  if (misses.size > 500) for (const [key, v] of misses) if (!v.some(t => now - t < 60_000)) misses.delete(key);
  return over;
}
