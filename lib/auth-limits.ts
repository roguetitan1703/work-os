import 'server-only';
import { createHash } from 'node:crypto';
import { getDb } from './db';

// Per-account limit on failed sign-in steps (docs/auth.md), next to Better Auth's per-IP limits: a password,
// authenticator or backup code that fails 10 times in 15 minutes for one account locks that step for that account
// until the window passes. Counts only failures; a success clears them. Passkey sign-in is never limited.
// Stored in `authLimits` (TTL 1 h), so every server instance sees the same count. Not switched off by AUTH_RATE_LIMIT.

export const ACCOUNT_MAX_FAILURES = 10;
export const ACCOUNT_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_LOCKED_MESSAGE = 'Too many failed attempts for this account. Wait 15 minutes, or sign in with a passkey.';

/** A stable, non-reversible key: kind + hash of the account (email or user id). */
export const accountKey = (kind: 'signin' | '2fa' | 'reauth', account: string) =>
  `${kind}:${createHash('sha256').update(account.trim().toLowerCase()).digest('hex').slice(0, 32)}`;

type LimitDoc = { _id?: unknown; key: string; at: Date };

async function coll() {
  return (await getDb()).collection<LimitDoc>('authLimits');
}

export async function accountLocked(key: string): Promise<boolean> {
  const n = await (await coll()).countDocuments({ key, at: { $gt: new Date(Date.now() - ACCOUNT_WINDOW_MS) } }, { limit: ACCOUNT_MAX_FAILURES });
  return n >= ACCOUNT_MAX_FAILURES;
}

export async function recordAccountFailure(key: string): Promise<void> {
  await (await coll()).insertOne({ key, at: new Date() });
}

export async function clearAccountFailures(key: string): Promise<void> {
  await (await coll()).deleteMany({ key });
}
