import 'server-only';
import { headers } from 'next/headers';
import { SafeError } from './auth';
import { getAuth, idIn } from './auth-server';
import { accountKey, accountLocked, ACCOUNT_LOCKED_MESSAGE, clearAccountFailures, recordAccountFailure } from './auth-limits';
import type { Caller } from './caller';
import { getDb } from './db';
import { FRESH_MINUTES, REAUTH_MESSAGE } from './reauth-shared';

// "Fresh session" (docs/auth.md): adding a passkey, creating or rotating an API key and adding a computer need a
// sign-in, or a password re-entry, in the last FRESH_MINUTES. A stolen session cookie alone can't mint lasting
// credentials. The re-entry time is stored on Better Auth's session document (`reauthAt`), read from the database
// (never the cookie cache).

type SessionRow = { token: string; createdAt: Date; reauthAt?: Date };

async function currentSession(h: Headers): Promise<{ row: SessionRow; userId: string } | null> {
  const auth = await getAuth();
  const s = await auth.api.getSession({ headers: h, query: { disableCookieCache: true } }).catch(() => null);
  if (!s?.session?.token) return null;
  const row = await (await getDb()).collection<SessionRow>('session').findOne({ token: s.session.token }, { projection: { token: 1, createdAt: 1, reauthAt: 1 } });
  return row ? { row, userId: String(s.user.id) } : null;
}

/** True when the session behind these headers signed in or re-entered the password in the last FRESH_MINUTES. */
export async function isFresh(h: Headers): Promise<boolean> {
  const s = await currentSession(h);
  if (!s) return false;
  const t = Math.max(new Date(s.row.createdAt).getTime(), s.row.reauthAt ? new Date(s.row.reauthAt).getTime() : 0);
  return Date.now() - t < FRESH_MINUTES * 60_000;
}

/** Throws REAUTH_MESSAGE (the UI then asks for the password and retries) unless the caller's session is fresh. */
export async function requireFresh(c: Caller): Promise<void> {
  if (c.via !== 'session') throw new SafeError('Only a signed-in person can do this.');
  if (!(await isFresh(await headers()))) throw new SafeError(REAUTH_MESSAGE);
}

/** Checks the caller's password and marks their session fresh. Limited per account like sign-in. */
export async function confirmPassword(c: Caller, password: string): Promise<void> {
  if (c.via !== 'session') throw new SafeError('Only a signed-in person can do this.');
  const key = accountKey('reauth', c.userId);
  if (await accountLocked(key)) throw new SafeError(ACCOUNT_LOCKED_MESSAGE);
  const h = await headers();
  const s = await currentSession(h);
  if (!s || s.userId !== c.userId) throw new SafeError('Sign in again.');
  const db = await getDb();
  const account = await db.collection<{ password?: string }>('account').findOne({ userId: idIn(c.userId), providerId: 'credential' });
  if (!account?.password) throw new SafeError('Your account has no password yet. Set one with "Forgot password?" on the sign-in page.');
  const ctx = await (await getAuth()).$context;
  const ok = typeof password === 'string' && password.length <= 256 && (await ctx.password.verify({ hash: account.password, password }));
  if (!ok) {
    await recordAccountFailure(key);
    throw new SafeError('Wrong password.');
  }
  await clearAccountFailures(key);
  await db.collection<SessionRow>('session').updateOne({ token: s.row.token }, { $set: { reauthAt: new Date() } });
}
