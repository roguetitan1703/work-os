import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { SafeError } from './auth';
import { collections, type SettingsDoc } from './db';

// Authenticator-app (TOTP) second factor for password sign-in, plus the
// attempt limit shared by the password and code checks.
//
// The TOTP secret lives in the settings doc `_id: 'security'`, encrypted with
// AES-256-GCM under a key derived (HKDF) from SESSION_SECRET. Rotating
// SESSION_SECRET therefore invalidates the stored secret: turn TOTP off first.

const DOC_ID = 'security';
const ISSUER = 'Work OS';
const RECOVERY_COUNT = 10;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_GLOBAL = 300; // backstop against many-IP guessing
const WINDOW_MS = 15 * 60_000;

function key(info: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return Buffer.from(hkdfSync('sha256', secret, 'work-os', info, 32));
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key('totp-secret-v1'), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Bad TOTP secret format');
  const d = createDecipheriv('aes-256-gcm', key('totp-secret-v1'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// ── Recovery codes ──────────────────────────────────────────────────────────

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i

function newRecoveryCode(): string {
  const s = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

function normalizeCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashRecovery(code: string): string {
  return createHmac('sha256', key('recovery-codes-v1')).update(normalizeCode(code)).digest('hex');
}

function makeRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  return { codes, hashes: codes.map(hashRecovery) };
}

// ── State ───────────────────────────────────────────────────────────────────

async function securityDoc(): Promise<SettingsDoc | null> {
  const { settings } = await collections();
  return settings.findOne({ _id: DOC_ID });
}

export type TotpState = { enabled: boolean; recoveryLeft: number; enabledAt: string | null };

export async function getTotpState(): Promise<TotpState> {
  const t = (await securityDoc())?.totp;
  return { enabled: !!t, recoveryLeft: t?.recoveryHashes.length ?? 0, enabledAt: t?.enabledAt.toISOString() ?? null };
}

export async function isTotpEnabled(): Promise<boolean> {
  return !!(await securityDoc())?.totp;
}

// ── Setup / teardown ────────────────────────────────────────────────────────

/** Starts setup: a fresh secret (kept pending until confirmed), its otpauth URI and a QR code. */
export async function beginTotpSetup(): Promise<{ secret: string; uri: string; qr: string }> {
  if (await isTotpEnabled()) throw new SafeError('The authenticator app is already on. Turn it off first.');
  const secret = generateSecret();
  const uri = generateURI({ issuer: ISSUER, label: 'Work OS', secret });
  const { settings } = await collections();
  await settings.updateOne({ _id: DOC_ID }, { $set: { totpPending: { secret: encrypt(secret), createdAt: new Date() }, updatedAt: new Date() } }, { upsert: true });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  return { secret, uri, qr };
}

async function checkTotp(secret: string, code: string, afterStep?: number): Promise<number | null> {
  const token = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const r = await verify({ secret, token, epochTolerance: 30, ...(afterStep ? { afterTimeStep: afterStep } : {}) });
  return r.valid && 'timeStep' in r ? r.timeStep : null;
}

/** Confirms setup with one code from the app. Returns the recovery codes (shown once). */
export async function confirmTotpSetup(code: string): Promise<string[]> {
  const doc = await securityDoc();
  if (doc?.totp) throw new SafeError('The authenticator app is already on.');
  const pending = doc?.totpPending;
  if (!pending || Date.now() - pending.createdAt.getTime() > 30 * 60_000) throw new SafeError('Setup expired. Start again.');
  const step = await checkTotp(decrypt(pending.secret), code);
  if (step === null) throw new CodeError();
  const { codes, hashes } = makeRecoveryCodes();
  const { settings } = await collections();
  const res = await settings.updateOne(
    { _id: DOC_ID, totp: { $in: [null] } },
    { $set: { totp: { secret: pending.secret, enabledAt: new Date(), recoveryHashes: hashes, lastStep: step }, totpPending: null, updatedAt: new Date() } },
  );
  if (res.modifiedCount !== 1) throw new SafeError('The authenticator app is already on.');
  return codes;
}

export class CodeError extends SafeError {
  constructor() {
    super('Wrong code.');
  }
}

/**
 * Checks a 6-digit app code or an unused recovery code. Codes are single-use:
 * an app code can't be replayed (lastStep), a recovery code is removed.
 */
export async function verifySecondFactor(code: string): Promise<boolean> {
  const t = (await securityDoc())?.totp;
  if (!t) return false;
  const { settings } = await collections();
  const step = await checkTotp(decrypt(t.secret), code, t.lastStep);
  if (step !== null) {
    const r = await settings.updateOne({ _id: DOC_ID, 'totp.lastStep': { $lt: step } }, { $set: { 'totp.lastStep': step } });
    return r.modifiedCount === 1;
  }
  const norm = normalizeCode(code);
  if (norm.length !== 10) return false;
  const h = hashRecovery(norm);
  const r = await settings.updateOne({ _id: DOC_ID, 'totp.recoveryHashes': h }, { $pull: { 'totp.recoveryHashes': h } });
  return r.modifiedCount === 1;
}

/** Turns TOTP off. Needs a current app code (or a recovery code). */
export async function disableTotp(code: string): Promise<void> {
  if (!(await verifySecondFactor(code))) throw new CodeError();
  const { settings } = await collections();
  await settings.updateOne({ _id: DOC_ID }, { $set: { totp: null, totpPending: null, updatedAt: new Date() } });
}

/** Replaces all recovery codes. Needs a current code. Returns the new codes (shown once). */
export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  if (!(await verifySecondFactor(code))) throw new CodeError();
  const { codes, hashes } = makeRecoveryCodes();
  const { settings } = await collections();
  await settings.updateOne({ _id: DOC_ID, totp: { $ne: null } }, { $set: { 'totp.recoveryHashes': hashes, updatedAt: new Date() } });
  return codes;
}

// ── Attempt limit (password + codes) ────────────────────────────────────────
// 10 failures in 15 minutes from one IP locks password and code checks for that
// IP until the oldest failure ages out. A high global ceiling is a backstop
// against guessing from many IPs. Passkeys are never limited by this.

function unlockMinutes(oldest: Date): number {
  return Math.max(1, Math.ceil((oldest.getTime() + WINDOW_MS - Date.now()) / 60_000));
}

export async function authLockout(ip: string): Promise<{ locked: boolean; minutes: number }> {
  const { authFailures } = await collections();
  const since = new Date(Date.now() - WINDOW_MS);
  const [mine, all] = await Promise.all([
    authFailures.find({ ip, at: { $gt: since } }, { sort: { at: -1 }, limit: MAX_FAILURES_PER_IP, projection: { at: 1 } }).toArray(),
    authFailures.find({ at: { $gt: since } }, { sort: { at: -1 }, skip: MAX_FAILURES_GLOBAL - 1, limit: 1, projection: { at: 1 } }).toArray(),
  ]);
  if (mine.length >= MAX_FAILURES_PER_IP) return { locked: true, minutes: unlockMinutes(mine[mine.length - 1].at) };
  if (all.length) return { locked: true, minutes: unlockMinutes(all[0].at) };
  return { locked: false, minutes: 0 };
}

export async function recordAuthFailure(kind: 'password' | 'totp' | 'reset', ip: string): Promise<void> {
  const { authFailures } = await collections();
  await authFailures.insertOne({ _id: randomUUID(), kind, ip, at: new Date() });
}
