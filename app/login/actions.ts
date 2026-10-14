'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import {
  PENDING_2FA_COOKIE,
  SESSION_COOKIE,
  SafeError,
  checkPassword,
  clientIp,
  createPending2faValue,
  createSessionValue,
  pending2faCookieOptions,
  sessionCookieOptions,
  uiAuthConfigured,
  verifyPending2faValue,
} from '@/lib/auth';
import { authenticationOptions, relyingParty, verifyAuthentication } from '@/lib/passkeys';
import { PasswordRuleError } from '@/lib/password';
import { completePasswordReset, requestPasswordReset, ResetLinkError } from '@/lib/password-reset';
import { authLockout, CodeError, isTotpEnabled, recordAuthFailure, verifySecondFactor } from '@/lib/totp';

// These actions run before sign-in (proxy.ts lets /login through). Each one
// checks its own credential and is the only way in from this page.

function safeNext(next: unknown): string {
  const s = typeof next === 'string' ? next : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/today';
}

const slow = () => new Promise(r => setTimeout(r, 600)); // slow down guessing

async function startSession(): Promise<void> {
  const jar = await cookies();
  jar.delete({ name: PENDING_2FA_COOKIE, path: '/login' });
  jar.set(SESSION_COOKIE, await createSessionValue(), sessionCookieOptions());
}

export async function loginAction(formData: FormData): Promise<void> {
  const next = safeNext(formData.get('next'));
  const q = (extra: string) => `/login?${extra}&next=${encodeURIComponent(next)}`;
  if (!uiAuthConfigured()) redirect('/login?error=config');
  const ip = clientIp(await headers());
  if ((await authLockout(ip)).locked) redirect(q('error=locked'));

  const ok = await checkPassword(String(formData.get('password') ?? ''));
  if (!ok) {
    await recordAuthFailure('password', ip);
    await slow();
    redirect(q('error=1'));
  }

  if (await isTotpEnabled()) {
    (await cookies()).set(PENDING_2FA_COOKIE, await createPending2faValue(), pending2faCookieOptions());
    redirect(q('step=2fa'));
  }

  await startSession();
  redirect(next);
}

/** Second step after a correct password when the authenticator app is on. */
export async function secondFactorAction(formData: FormData): Promise<void> {
  const next = safeNext(formData.get('next'));
  const q = (extra: string) => `/login?${extra}&next=${encodeURIComponent(next)}`;
  if (!uiAuthConfigured()) redirect('/login?error=config');
  const jar = await cookies();
  if (!(await verifyPending2faValue(jar.get(PENDING_2FA_COOKIE)?.value))) redirect(q('error=expired'));
  const ip = clientIp(await headers());
  if ((await authLockout(ip)).locked) redirect(q('error=locked'));

  if (!(await verifySecondFactor(String(formData.get('code') ?? '')))) {
    await recordAuthFailure('totp', ip);
    await slow();
    redirect(q('step=2fa&error=code'));
  }

  await startSession();
  redirect(next);
}

type PasskeyResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Challenge for "Sign in with passkey" (and the autofill prompt). */
export async function passkeyOptionsAction(): Promise<PasskeyResult<PublicKeyCredentialRequestOptionsJSON>> {
  try {
    if (!uiAuthConfigured()) return { ok: false, error: 'Auth is not configured on the server.' };
    const h = await headers();
    return { ok: true, data: await authenticationOptions(relyingParty(h), clientIp(h)) };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('passkey options failed', e);
    return { ok: false, error: 'Could not start passkey sign-in.' };
  }
}

/** Verifies the passkey and sets the session cookie. Passkeys skip the TOTP step. */
export async function passkeyLoginAction(response: AuthenticationResponseJSON, next: string): Promise<PasskeyResult<string>> {
  try {
    if (!uiAuthConfigured()) return { ok: false, error: 'Auth is not configured on the server.' };
    if (!(await verifyAuthentication(relyingParty(await headers()), response))) {
      await slow();
      return { ok: false, error: 'That passkey was not recognised. Try again or use your password.' };
    }
    await startSession();
    return { ok: true, data: safeNext(next) };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('passkey sign-in failed', e);
    return { ok: false, error: 'Passkey sign-in failed. Try again or use your password.' };
  }
}

// ── Forgot password ─────────────────────────────────────────────────────────

/** "Email me a reset link". Always ends on the same neutral message, whatever happened. */
export async function requestResetAction(): Promise<void> {
  if (uiAuthConfigured()) {
    const h = await headers();
    let origin: string | null = null;
    try {
      origin = relyingParty(h).origin; // same origin rules as passkeys
    } catch (e) {
      console.error('reset link origin:', e instanceof Error ? e.message : e);
    }
    if (origin) await requestPasswordReset(origin, clientIp(h));
  }
  await slow();
  redirect('/login?step=forgot&sent=1');
}

/** Sets the new password from a reset link (app/login/reset/page.tsx). */
export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').slice(0, 100);
  const back = (error: string) => `/login/reset?token=${encodeURIComponent(token)}&error=${error}`;
  if (!uiAuthConfigured()) redirect('/login?error=config');
  const ip = clientIp(await headers());
  let error: string | null = null;
  try {
    await completePasswordReset({
      token,
      password: String(formData.get('password') ?? ''),
      again: String(formData.get('again') ?? ''),
      code: String(formData.get('code') ?? ''),
      ip,
    });
  } catch (e) {
    if (e instanceof ResetLinkError) error = 'link';
    else if (e instanceof CodeError) error = 'code';
    else if (e instanceof PasswordRuleError) error = e.reason;
    else if (e instanceof SafeError) error = 'locked';
    else {
      console.error('password reset failed', e);
      error = 'failed';
    }
  }
  if (error) {
    await slow();
    redirect(back(error));
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE); // every session is now invalid anyway
  redirect('/login?reset=done');
}
