import 'server-only';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { SafeError } from './auth';
import { collections, type MailLogDoc } from './db';

// Outgoing email (SMTP via nodemailer). Mail only ever goes to the owner:
// OWNER_EMAIL, else EMAIL_FROM. There is deliberately no "to" parameter.
//
//   EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE (true = TLS from the start, e.g. port 465)
//   EMAIL_USER, EMAIL_PASSWORD   SMTP login
//   EMAIL_FROM, EMAIL_FROM_NAME  sender address and display name
//   OWNER_EMAIL                  the only recipient (defaults to EMAIL_FROM)

const REQUIRED = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASSWORD', 'EMAIL_FROM'] as const;

/** Names (never values) of the email env vars that are missing. */
export function missingMailEnv(): string[] {
  return REQUIRED.filter(k => !process.env[k]?.trim());
}

export function mailConfigured(): boolean {
  return missingMailEnv().length === 0;
}

export function ownerEmail(): string | null {
  return process.env.OWNER_EMAIL?.trim() || process.env.EMAIL_FROM?.trim() || null;
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

/** Sends a plain-text email to the owner. Throws SafeError if email is not configured. */
export async function sendOwnerMail(msg: { subject: string; text: string }): Promise<void> {
  const t = transport();
  const to = ownerEmail()!;
  const from = process.env.EMAIL_FROM!.trim();
  const name = process.env.EMAIL_FROM_NAME?.trim() || 'Work OS';
  try {
    await t.sendMail({ from: { name, address: from }, to, subject: msg.subject, text: msg.text });
  } finally {
    t.close();
  }
}

// ── Hourly limits ───────────────────────────────────────────────────────────

const HOURLY_LIMIT: Record<MailLogDoc['kind'], number> = { reset: 3, test: 5, changed: 10 };

/**
 * Records one send of `kind` and says whether it is within the hourly limit.
 * Insert-then-count, so concurrent callers can't both slip under the limit.
 */
export async function takeMailSlot(kind: MailLogDoc['kind']): Promise<boolean> {
  const { mailLog } = await collections();
  const at = new Date();
  await mailLog.insertOne({ _id: randomUUID(), kind, at });
  const n = await mailLog.countDocuments({ kind, at: { $gt: new Date(at.getTime() - 3_600_000) } });
  return n <= HOURLY_LIMIT[kind];
}

/** Short reason for a failed send, without server responses that could echo config. */
export function mailErrorMessage(e: unknown): string {
  if (e instanceof SafeError) return e.message;
  const code = (e as { code?: unknown })?.code;
  return `Sending failed${typeof code === 'string' && /^[A-Z_]{2,20}$/.test(code) ? ` (${code})` : ''}. Check the EMAIL_* settings.`;
}
