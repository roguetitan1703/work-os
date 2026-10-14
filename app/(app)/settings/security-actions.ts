'use server';

import { cookies, headers } from 'next/headers';
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { SESSION_COOKIE, SafeError, checkPassword, clientIp, createSessionValue, sessionCookieOptions, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { mailConfigured, mailErrorMessage, missingMailEnv, ownerEmail, sendOwnerMail, takeMailSlot } from '@/lib/mail';
import { hasStoredPassword, setPassword, validateNewPassword } from '@/lib/password';
import { notifyPasswordChanged } from '@/lib/password-reset';
import { listPasskeys, registrationOptions, relyingParty, removePasskey, renamePasskey, verifyRegistration, type PasskeyInfo } from '@/lib/passkeys';
import {
  authLockout,
  beginTotpSetup,
  CodeError,
  confirmTotpSetup,
  disableTotp,
  getTotpState,
  isTotpEnabled,
  recordAuthFailure,
  regenerateRecoveryCodes,
  verifySecondFactor,
  type TotpState,
} from '@/lib/totp';

type R<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function requireUser(): Promise<void> {
  if (uiAuthDisabled()) return;
  if (!(await verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value))) throw new SafeError('Not signed in.');
}

async function run<T>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    await requireUser();
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('security action failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

/** Code-checking actions share the sign-in attempt limit. */
async function withCode<T>(fn: () => Promise<T>): Promise<T> {
  const ip = clientIp(await headers());
  const lock = await authLockout(ip);
  if (lock.locked) throw new SafeError(`Too many wrong codes. Try again in ${lock.minutes} min.`);
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CodeError) await recordAuthFailure('totp', ip);
    throw e;
  }
}

export type EmailState = { configured: boolean; missing: string[]; to: string | null };
export type SecurityState = { passkeys: PasskeyInfo[]; totp: TotpState; storedPassword: boolean; email: EmailState };

export async function getSecurityStateAction(): Promise<R<SecurityState>> {
  return run(async () => {
    const [passkeys, totp, storedPassword] = await Promise.all([listPasskeys(), getTotpState(), hasStoredPassword()]);
    return { passkeys, totp, storedPassword, email: { configured: mailConfigured(), missing: missingMailEnv(), to: ownerEmail() } };
  });
}

// ── Password and email ──────────────────────────────────────────────────────

class WrongPasswordError extends SafeError {
  constructor() {
    super('Wrong current password.');
  }
}

/**
 * Changes the password (stored as an scrypt hash, see lib/password.ts). Needs the
 * current password and, when TOTP is on, a current code. Signs out every other
 * session; this device gets a fresh session cookie.
 */
export async function changePasswordAction(input: { current: string; password: string; again: string; code: string }): Promise<R> {
  return run(async () => {
    if (uiAuthDisabled()) throw new SafeError('Login is off in this dev setup (APP_PASSWORD unset).');
    const ip = clientIp(await headers());
    const lock = await authLockout(ip);
    if (lock.locked) throw new SafeError(`Too many failed attempts. Try again in ${lock.minutes} min.`);
    if (!(await checkPassword(String(input.current ?? '')))) {
      await recordAuthFailure('password', ip);
      throw new WrongPasswordError();
    }
    const password = String(input.password ?? '');
    validateNewPassword(password, String(input.again ?? ''));
    if ((await isTotpEnabled()) && !(await verifySecondFactor(String(input.code ?? '')))) {
      await recordAuthFailure('totp', ip);
      throw new CodeError();
    }
    const gen = await setPassword(password);
    (await cookies()).set(SESSION_COOKIE, await createSessionValue(gen), sessionCookieOptions());
    await notifyPasswordChanged('settings', ip);
    return undefined;
  });
}

/** Sends a test email to the owner address. At most 5 an hour. */
export async function sendTestEmailAction(): Promise<R<string>> {
  return run(async () => {
    const missing = missingMailEnv();
    if (missing.length) throw new SafeError(`Email is not set up. Missing: ${missing.join(', ')}.`);
    if (!(await takeMailSlot('test'))) throw new SafeError('Too many test emails. Try again in an hour.');
    try {
      await sendOwnerMail({
        subject: 'Work OS test email',
        text: `This is a test from Work OS (Settings → Security), sent ${new Date().toISOString()}.
Password reset links will come from this address.`,
      });
    } catch (e) {
      console.error('test email failed', e);
      throw new SafeError(mailErrorMessage(e));
    }
    return ownerEmail() ?? '';
  });
}

// ── Passkeys ────────────────────────────────────────────────────────────────

export async function passkeyRegisterOptionsAction(): Promise<R<PublicKeyCredentialCreationOptionsJSON>> {
  return run(async () => {
    const h = await headers();
    return registrationOptions(relyingParty(h), clientIp(h));
  });
}

export async function passkeyRegisterAction(response: RegistrationResponseJSON, deviceName: string): Promise<R<PasskeyInfo[]>> {
  return run(async () => {
    await verifyRegistration(relyingParty(await headers()), response, deviceName);
    return listPasskeys();
  });
}

export async function renamePasskeyAction(id: string, name: string): Promise<R<PasskeyInfo[]>> {
  return run(async () => {
    await renamePasskey(String(id), String(name));
    return listPasskeys();
  });
}

export async function removePasskeyAction(id: string): Promise<R<PasskeyInfo[]>> {
  return run(async () => {
    await removePasskey(String(id));
    return listPasskeys();
  });
}

// ── Authenticator app (TOTP) ────────────────────────────────────────────────

export async function totpBeginAction(): Promise<R<{ secret: string; uri: string; qr: string }>> {
  return run(() => beginTotpSetup());
}

/** Returns the recovery codes, shown once. */
export async function totpConfirmAction(code: string): Promise<R<string[]>> {
  return run(() => withCode(() => confirmTotpSetup(String(code))));
}

export async function totpDisableAction(code: string): Promise<R> {
  return run(async () => {
    await withCode(() => disableTotp(String(code)));
    return undefined;
  });
}

/** Returns the new recovery codes, shown once. */
export async function totpRegenerateCodesAction(code: string): Promise<R<string[]>> {
  return run(() => withCode(() => regenerateRecoveryCodes(String(code))));
}
