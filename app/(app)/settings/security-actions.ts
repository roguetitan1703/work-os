'use server';

import { cookies, headers } from 'next/headers';
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { SESSION_COOKIE, SafeError, clientIp, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { listPasskeys, registrationOptions, relyingParty, removePasskey, renamePasskey, verifyRegistration, type PasskeyInfo } from '@/lib/passkeys';
import { authLockout, beginTotpSetup, CodeError, confirmTotpSetup, disableTotp, getTotpState, recordAuthFailure, regenerateRecoveryCodes, type TotpState } from '@/lib/totp';

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

export type SecurityState = { passkeys: PasskeyInfo[]; totp: TotpState };

export async function getSecurityStateAction(): Promise<R<SecurityState>> {
  return run(async () => {
    const [passkeys, totp] = await Promise.all([listPasskeys(), getTotpState()]);
    return { passkeys, totp };
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
