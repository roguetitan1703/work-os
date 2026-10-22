import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { SafeError } from './auth';
import { collections, type MailLogDoc } from './db';

// Outgoing email (SMTP via nodemailer): password reset links, password-changed notices, invitations and the
// Settings test email. Each goes to the address of the person it is about (`to`), never to anyone else.
//
//   EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE (true = TLS from the start, e.g. port 465)
//   EMAIL_USER, EMAIL_PASSWORD   SMTP login
//   EMAIL_FROM, EMAIL_FROM_NAME  sender address and display name
//   MAIL_CAPTURE_DIR             tests only: write each mail as a JSON file in this folder instead of sending it

const REQUIRED = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASSWORD', 'EMAIL_FROM'] as const;

const captureDir = () => process.env.MAIL_CAPTURE_DIR?.trim() || null;

/** Names (never values) of the email env vars that are missing. */
export function missingMailEnv(): string[] {
  if (captureDir()) return [];
  return REQUIRED.filter(k => !process.env[k]?.trim());
}

export function mailConfigured(): boolean {
  return missingMailEnv().length === 0;
}

function transport() {
  const missing = missingMailEnv();
  if (missing.length) throw new SafeError(`Email is not set up. Missing: ${missing.join(', ')}.`);
  const port = Number(process.env.EMAIL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SafeError('EMAIL_PORT must be a port number.');
  const secure = /^(1|true|yes)$/i.test(process.env.EMAIL_SECURE?.trim() ?? '');
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST!.trim(),
    port,
    secure,
    requireTLS: !secure, // never send the password or a reset link in clear text
    auth: { user: process.env.EMAIL_USER!.trim(), pass: process.env.EMAIL_PASSWORD! },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Sends a plain-text email to `to`. Throws SafeError if email is not configured. */
export async function sendMail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const to = msg.to.trim();
  if (!EMAIL.test(to)) throw new SafeError('That is not an email address.');
  const dir = captureDir();
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to, subject: msg.subject, text: msg.text, at: new Date().toISOString() }));
    return;
  }
  const t = transport();
  const from = process.env.EMAIL_FROM!.trim();
  const name = process.env.EMAIL_FROM_NAME?.trim() || 'Work OS';
  try {
    await t.sendMail({ from: { name, address: from }, to, subject: msg.subject, text: msg.text });
  } finally {
    t.close();
  }
}

// ── Hourly limits ───────────────────────────────────────────────────────────

/** Per recipient and kind, per hour. */
const HOURLY_LIMIT: Record<MailLogDoc['kind'], number> = { reset: 3, test: 5, changed: 10, invite: 10 };
/** Across all recipients, per hour: a backstop against using the site to send mail. */
const HOURLY_TOTAL = 60;

const hashTo = (to: string) => createHash('sha256').update(to.trim().toLowerCase()).digest('hex').slice(0, 32);

/**
 * Records one send of `kind` to `to` and says whether it is within the hourly limits.
 * Insert-then-count, so concurrent callers can't both slip under the limit. Only a hash of the address is kept.
 */
export async function takeMailSlot(kind: MailLogDoc['kind'], to: string): Promise<boolean> {
  const { mailLog } = await collections();
  const at = new Date();
  const toHash = hashTo(to);
  await mailLog.insertOne({ _id: randomUUID(), kind, at, to: toHash });
  const since = new Date(at.getTime() - 3_600_000);
  const [mine, all] = await Promise.all([mailLog.countDocuments({ kind, to: toHash, at: { $gt: since } }), mailLog.countDocuments({ at: { $gt: since } })]);
  return mine <= HOURLY_LIMIT[kind] && all <= HOURLY_TOTAL;
}

/** Short reason for a failed send, without server responses that could echo config. */
export function mailErrorMessage(e: unknown): string {
  if (e instanceof SafeError) return e.message;
  const code = (e as { code?: unknown })?.code;
  return `Sending failed${typeof code === 'string' && /^[A-Z_]{2,20}$/.test(code) ? ` (${code})` : ''}. Check the EMAIL_* settings.`;
}
