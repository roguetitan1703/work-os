import 'server-only';
import { randomUUID } from 'node:crypto';

// Client for Mailloom's agent API (Mailloom docs/agent-api.md): Work OS calls it server to server on behalf of ONE
// person, with that person's own agent key. The key never leaves this module except in the Authorization header of
// the call; errors carry only Mailloom's own plain sentence and code, never the key.
//
//   MAILLOOM_AGENT_URL   https://<mailloom host>/api/agent/v1  (http only for localhost, for tests)
//   MAILLOOM_WEB_URL     optional: the Mailloom web address, for the link back on a task (default: the host above)
//
// Retries: only calls that are safe to repeat (reads, and sends with an idempotency key, which is reused) and only on
// a network failure, a timeout or a 502. A 429 is retried once when Mailloom says to wait 3 seconds or less.

export class MailError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

const TIMEOUT_MS = 20_000;
const MAX_BODY = 25_000_000; // an attachment is capped at 10 MB by Mailloom (about 13.5 MB as base64)
const KEY_SHAPE = /^mlk_[A-Za-z0-9_-]{43}$/;

export const looksLikeKey = (k: string) => KEY_SHAPE.test(k);

const isLocal = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';

/** The agent API's base address, or null when Mail is not set up on this Work OS. */
export function mailBase(): string | null {
  const raw = process.env.MAILLOOM_AGENT_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal(u))) return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export const mailConfigured = () => mailBase() !== null;

/** Where a person opens Mailloom: MAILLOOM_WEB_URL, else the host of the agent address. */
export function mailWebUrl(): string | null {
  const web = process.env.MAILLOOM_WEB_URL?.trim();
  const pick = web || mailBase();
  if (!pick) return null;
  try {
    const u = new URL(pick);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal(u))) return null;
    return web ? web.replace(/\/+$/, '') : u.origin;
  } catch {
    return null;
  }
}

export type Ids = { user: string; session: string };
export type Query = Record<string, string | number | boolean | undefined | null>;
type Opts = { query?: Query; body?: unknown; idempotencyKey?: string; retry?: boolean };

const SETUP = 'Settings › Connections › Mail';

/** What Work OS tells Claude and the person for a Mailloom error, in plain words. */
export function explain(status: number, code: string, message: string, retryAfter?: number): string {
  switch (code) {
    case 'KEY_BROKEN':
      return `Your mailbox password was refused by the mail server (usually after a password change), so your Mailloom key no longer works. Open Mailloom › Connections, rotate the key (you enter the new password), then paste the new key in Work OS ${SETUP}. (KEY_BROKEN)`;
    case 'MISSING_KEY':
    case 'INVALID_KEY':
    case 'KEY_REVOKED':
      return `Mailloom does not accept your saved key (${code}). Create a new key in Mailloom › Connections and paste it in Work OS ${SETUP}.`;
    case 'IN_PROGRESS':
      return 'A send with this idempotency key is still running or ended without a result. Do not send it again: check the Sent folder (mail_search with folder "Sent") first. (IN_PROGRESS)';
    case 'AGENT_API_OFF':
      return 'Mailloom has its agent API switched off. Ask the operator of Mailloom to switch it on. (AGENT_API_OFF)';
    case 'IP_NOT_ALLOWED':
      return 'Mailloom does not allow this Work OS server to call it (IP_NOT_ALLOWED). The operator must add this server to AGENT_ALLOWED_IPS in Mailloom.';
    case 'SCOPE_MISSING':
      return `Your Mailloom key lacks the permission for this (SCOPE_MISSING: ${message}). Create a key with read, organise and send access in Mailloom › Connections.`;
    case 'RATE_LIMITED':
      return `Mailloom's hourly send limit for your key is reached. Try again in ${retryAfter ?? 'a few'} seconds or later. (RATE_LIMITED)`;
    case 'MESSAGE_TOO_LARGE':
    case 'ATTACHMENT_TOO_LARGE':
      return `${message} (${code})`;
  }
  if (status === 413) return `${message} (${code || 'too large'})`;
  if (status === 429) return `Mailloom asks to slow down. Try again in ${retryAfter ?? 'a few'} seconds. (RATE_LIMITED)`;
  if (status === 401) return `Mailloom does not accept your saved key. Create a new key in Mailloom › Connections and paste it in Work OS ${SETUP}.`;
  if (status === 403) return `Mailloom refused this: ${message} (${code || '403'}).`;
  if (status >= 500) return `Mailloom could not reach the mail server right now (${code || status}). Try again in a minute.`;
  return `${message || 'Mailloom refused the request.'}${code ? ` (${code})` : ''}`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function readBody(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new MailError('Mailloom sent too much data.', res.status, 'TOO_BIG');
  const text = await res.text();
  if (text.length > MAX_BODY) throw new MailError('Mailloom sent too much data.', res.status, 'TOO_BIG');
  return text;
}

/** One call to the agent API with a person's key. Throws MailError with a plain message. */
export async function mailRequest<T>(key: string, ids: Ids, method: 'GET' | 'POST', path: string, opts: Opts = {}): Promise<T> {
  const base = mailBase();
  if (!base) throw new MailError('Mail is not set up on this Work OS (MAILLOOM_AGENT_URL is not set).', 0, 'NOT_CONFIGURED');
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    'x-workos-user': ids.user.slice(0, 200),
    'x-workos-session': ids.session.slice(0, 200),
  };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const retryable = opts.retry ?? (method === 'GET' || !!opts.idempotencyKey);
  let waited429 = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (retryable && attempt < 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new MailError(timedOut ? 'Mailloom did not answer in time.' : 'Could not reach Mailloom.', 0, timedOut ? 'TIMEOUT' : 'UNREACHABLE');
    }
    const text = await readBody(res);
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      if (data === null || typeof data !== 'object') throw new MailError('Mailloom sent an answer Work OS could not read.', res.status, 'BAD_RESPONSE');
      return data as T;
    }
    const d = (data && typeof data === 'object' ? data : {}) as { code?: unknown; error?: unknown };
    const code = typeof d.code === 'string' ? d.code.slice(0, 60) : '';
    const message = typeof d.error === 'string' ? d.error.slice(0, 300) : '';
    const ra = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined;
    if (res.status === 429 && retryable && !waited429 && retryAfter !== undefined && retryAfter <= 3) {
      waited429 = true;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 502 && retryable && attempt < 2) {
      await sleep(400 * (attempt + 1));
      continue;
    }
    throw new MailError(explain(res.status, code, message, retryAfter), res.status, code, retryAfter);
  }
}

/** A fresh idempotency key: one per intended mail, reused on every retry of that mail. */
export const newIdempotencyKey = () => `wos-${randomUUID()}`;

// ── Shapes (agent-api.md) ───────────────────────────────────────────────────

export type Addr = { name?: string; address: string };
export type MessageSummary = { folder: string; uid: number; message_id: string; from: Addr | null; to: Addr[]; cc: Addr[]; subject: string; date: string; unread: boolean; flagged: boolean; answered: boolean; size: number; has_attachments: boolean };
export type Whoami = { email: string; key: { id: string; prefix: string; name: string; scopes: string[]; created_at: string }; limits: { sends_per_hour: number; recipients_per_mail: number } };
export type MessageFull = {
  folder: string;
  uid: number;
  message_id: string;
  in_reply_to?: string | null;
  references?: string[];
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  reply_to?: Addr[] | Addr | null;
  subject: string;
  date: string;
  text: string;
  attachments?: { index: number; filename: string; content_type: string; size: number }[];
};
export type SendResult = { sent: boolean; message_id?: string; accepted?: string[]; rejected?: string[]; saved_to_sent?: boolean; sent_folder?: string | null; idempotent_replay?: boolean };

export const whoami = (key: string, ids: Ids) => mailRequest<Whoami>(key, ids, 'GET', '/whoami');
