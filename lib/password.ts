import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { SafeError } from './auth';
import { collections } from './db';

// The stored password and the session generation, both in the settings doc
// `_id: 'security'`.
//
// - passwordHash: set by a reset (lib/password-reset.ts) or Settings → Security.
//   While it exists it is the only password; APP_PASSWORD is the fallback only
//   when no hash is stored.
// - sessionGen: every session cookie carries the generation it was issued in
//   (lib/auth.ts). Changing the password bumps it, which signs out every session.

const DOC_ID = 'security';
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;

// scrypt, N=2^15 r=8 p=1 (~32 MB, tens of ms). Parameters are stored with the hash.
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(pw: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const maxmem = (n: number, r: number) => 128 * n * r * 2;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyHash(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  const nn = Number(n), rr = Number(r), pp = Number(p);
  if (alg !== 'scrypt' || !salt || !key || !(nn >= 1024 && nn <= 131_072) || !(rr >= 1 && rr <= 16) || !(pp >= 1 && pp <= 4)) return false;
  if (pw.length > MAX_PASSWORD) return false;
  const expected = Buffer.from(key, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), { N: nn, r: rr, p: pp, maxmem: maxmem(nn, rr) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The stored hash, or null when the password is still APP_PASSWORD. */
async function storedHash(): Promise<string | null> {
  const { settings } = await collections();
  const doc = await settings.findOne({ _id: DOC_ID }, { projection: { passwordHash: 1 } });
  return doc?.passwordHash ?? null;
}

export async function hasStoredPassword(): Promise<boolean> {
  return !!(await storedHash());
}

/** Checks against the stored hash; returns null when none is stored (caller falls back to APP_PASSWORD). */
export async function checkStoredPassword(input: string): Promise<boolean | null> {
  const h = await storedHash();
  if (!h) return null;
  return verifyHash(input, h);
}

export class PasswordRuleError extends SafeError {
  constructor(readonly reason: 'short' | 'long' | 'mismatch') {
    super(
      reason === 'short' ? `Use at least ${MIN_PASSWORD} characters.` : reason === 'long' ? `Use at most ${MAX_PASSWORD} characters.` : 'The two passwords do not match.',
    );
  }
}

/** Throws PasswordRuleError when the new password is not acceptable. */
export function validateNewPassword(pw: string, again: string): void {
  if (pw.length < MIN_PASSWORD) throw new PasswordRuleError('short');
  if (pw.length > MAX_PASSWORD) throw new PasswordRuleError('long');
  if (pw !== again) throw new PasswordRuleError('mismatch');
}

// ── Session generation ──────────────────────────────────────────────────────
// Read on every signed-in request (proxy.ts), so it is cached per server
// instance for a few seconds. The instance that bumps it updates its cache at
// once; other instances pick it up within GEN_CACHE_MS.

const GEN_CACHE_MS = 5_000;
const g = globalThis as unknown as { __workosSessionGen?: { gen: number; at: number }; __workosSessionGenLoad?: Promise<number> };

/** `fresh` skips the cache (used when issuing a new session). Concurrent misses share one query. */
export async function currentSessionGen(fresh = false): Promise<number> {
  const c = g.__workosSessionGen;
  if (!fresh && c && Date.now() - c.at < GEN_CACHE_MS) return c.gen;
  if (!fresh && g.__workosSessionGenLoad) return g.__workosSessionGenLoad;
  const load = (async () => {
    const { settings } = await collections();
    const doc = await settings.findOne({ _id: DOC_ID }, { projection: { sessionGen: 1 } });
    const gen = doc?.sessionGen ?? 0;
    g.__workosSessionGen = { gen, at: Date.now() };
    return gen;
  })();
  if (!fresh) g.__workosSessionGenLoad = load;
  try {
    return await load;
  } finally {
    if (g.__workosSessionGenLoad === load) g.__workosSessionGenLoad = undefined;
  }
}

/** Stores the new password hash and signs out every session. Returns the new generation. */
export async function setPassword(pw: string): Promise<number> {
  const hash = await hashPassword(pw);
  const { settings } = await collections();
  const doc = await settings.findOneAndUpdate(
    { _id: DOC_ID },
    { $set: { passwordHash: hash, passwordChangedAt: new Date(), updatedAt: new Date() }, $inc: { sessionGen: 1 } },
    { upsert: true, returnDocument: 'after', projection: { sessionGen: 1 } },
  );
  const gen = doc?.sessionGen ?? 1;
  g.__workosSessionGen = { gen, at: Date.now() };
  return gen;
}
