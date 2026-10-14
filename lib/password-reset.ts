import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { SafeError } from './auth';
import { collections } from './db';
import { mailErrorMessage, sendOwnerMail, takeMailSlot } from './mail';
import { addToInbox } from './notify';
import { setPassword, validateNewPassword } from './password';
import { authLockout, CodeError, isTotpEnabled, recordAuthFailure, verifySecondFactor } from './totp';

// "Forgot password" by email.
//
// The link carries a random 32-byte token; only its SHA-256 is stored, in
// passwordResets with a 15-minute TTL index. A new request never cancels a link
// that is still live (so a stranger can't wipe the owner's pending link), and no
// new email goes out within 2 minutes of the last one. A token is deleted when it
// is used (single use), and completing a reset deletes them all. Requests
// count toward the per-IP auth limit (lib/totp.ts) and at most 3 reset emails
// go out per hour in total. Mail only goes to OWNER_EMAIL (lib/mail.ts).

const TOKEN_MS = 15 * 60_000;
const COOLDOWN_MS = 2 * 60_000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenShapeOk = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

/**
 * Sends a reset link if the limits allow. Never throws and never reports the
 * outcome: the caller always shows the same neutral message.
 */
export async function requestPasswordReset(origin: string, ip: string): Promise<void> {
  try {
    if ((await authLockout(ip)).locked) return;
    await recordAuthFailure('reset', ip); // each request counts toward the per-IP limit
    const { passwordResets } = await collections();
    const now = new Date();
    if (await passwordResets.findOne({ createdAt: { $gt: new Date(now.getTime() - COOLDOWN_MS) } })) return;
    if (!(await takeMailSlot('reset'))) return;

    const token = randomBytes(32).toString('base64url');
    await passwordResets.insertOne({ _id: hashToken(token), createdAt: now, expiresAt: new Date(now.getTime() + TOKEN_MS), ip });

    const link = `${origin}/login/reset?token=${token}`;
    try {
      await sendOwnerMail({
        subject: 'Reset your Work OS password',
        text: [
          'Someone (hopefully you) asked to reset the Work OS password.',
          '',
          `Open this link within 15 minutes to choose a new password:`,
          link,
          '',
          'The link works once.',
          "If this wasn't you, ignore this email; your password stays the same.",
          `Requested from IP ${ip} at ${now.toISOString()}.`,
        ].join('\n'),
      });
    } catch (e) {
      await passwordResets.deleteOne({ _id: hashToken(token) });
      console.error('reset email failed:', mailErrorMessage(e));
    }
  } catch (e) {
    console.error('password reset request failed', e);
  }
}

/** true when the token is a live reset token (does not use it up). */
export async function resetTokenValid(token: string): Promise<boolean> {
  if (!tokenShapeOk(token)) return false;
  const { passwordResets } = await collections();
  const doc = await passwordResets.findOne({ _id: hashToken(token) });
  return !!doc && doc.expiresAt.getTime() > Date.now();
}

export class ResetLinkError extends SafeError {
  constructor() {
    super('This reset link is invalid, expired or already used. Ask for a new one.');
  }
}

/**
 * Completes a reset: checks the token, the new password (twice) and, when TOTP
 * is on, a current app code or an unused recovery code; then stores the new
 * password and signs out every session. Throws SafeError (ResetLinkError,
 * CodeError, ...) on failure; wrong tokens and codes count toward the IP limit.
 */
export async function completePasswordReset(input: { token: string; password: string; again: string; code: string; ip: string }): Promise<void> {
  const { token, password, again, code, ip } = input;
  const lock = await authLockout(ip);
  if (lock.locked) throw new SafeError(`Too many failed attempts. Try again in ${lock.minutes} min.`);

  if (!(await resetTokenValid(token))) {
    await recordAuthFailure('reset', ip);
    throw new ResetLinkError();
  }
  validateNewPassword(password, again);
  if (await isTotpEnabled()) {
    if (!(await verifySecondFactor(code))) {
      await recordAuthFailure('totp', ip);
      throw new CodeError();
    }
  }

  // Claim the token atomically: only one request can use it.
  const { passwordResets } = await collections();
  const claimed = await passwordResets.findOneAndDelete({ _id: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!claimed) throw new ResetLinkError();

  await setPassword(password);
  await passwordResets.deleteMany({});
  await notifyPasswordChanged('reset', ip);
}

/** Inbox notice plus a "your password was changed" email. Never throws. */
export async function notifyPasswordChanged(how: 'reset' | 'settings', ip: string): Promise<void> {
  const when = new Date().toISOString();
  const via = how === 'reset' ? 'with an email reset link' : 'in Settings → Security';
  await addToInbox([
    { kind: 'security', title: 'Password changed', body: `Changed ${via}. All other sessions were signed out.`, url: '/settings' },
  ]).catch(e => console.error('password-changed inbox notice failed', e));
  try {
    if (await takeMailSlot('changed')) {
      await sendOwnerMail({
        subject: 'Your Work OS password was changed',
        text: [
          `Your Work OS password was changed ${via} at ${when} (IP ${ip}).`,
          'Every signed-in device was signed out.',
          '',
          "If this wasn't you, sign in with a passkey or reset the password again, and check Settings → Security.",
        ].join('\n'),
      });
    }
  } catch (e) {
    console.error('password-changed email failed:', mailErrorMessage(e));
  }
}
