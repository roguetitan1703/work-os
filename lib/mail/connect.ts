import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SafeError, appBaseUrl } from '../auth';
import { getAuth } from '../auth-server';
import type { Caller } from '../caller';
import { collections } from '../db';
import { orgName } from '../people';
import { setUserSetting, type Scope } from '../scope';
import { MAILLOOM_CONNECT, connectConfig, looksLikeKey, revokeKey, whoami, type ConnectConfig, type Ids } from './client';
import { sealMailKey, sealText, storedKeyOf, unsealText } from './keys';

// Connect Mailloom (docs/flows/mail-connect.md): instead of pasting a key, a person allows Work OS in Mailloom and
// Mailloom mints the key, handed over server to server. OAuth authorization code + PKCE S256 + state + client secret,
// the same shape as Work OS's Delpat OS link (lib/delpat-os.ts). Endpoints and env names: MAILLOOM_CONNECT in ./client.
//
// Security notes:
//  - The key travels only Mailloom's token reply → this server → sealed in `settings` mail:<userId> (lib/mail/keys.ts).
//    It is never in a URL, a page, a log or an error. Errors name a fixed reason only.
//  - The state is 256 random bits, stored hashed, single use (findOneAndDelete), 10 minutes, and bound to the person,
//    organization and session that started it; the callback rechecks the signed-in caller against all three.
//  - The PKCE verifier never leaves this server (sealed next to the state). The redirect URI is fixed from APP_URL.
//  - Mailloom calls: https only (http for localhost tests), no redirects followed, 10 s timeout, 1 MB cap, reply shape
//    checked, and the new key must say (whoami) it opens the same mailbox the token reply named.

const AUTH_MINUTES = 10;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 1_000_000;
const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const KNOWN_SCOPES = new Set<string>(MAILLOOM_CONNECT.scopes);

/** A refusal with one fixed word for the callback's redirect; the message is plain and never carries Mailloom's text. */
export class ConnectError extends SafeError {
  constructor(public flag: 'denied' | 'error') {
    super(flag === 'denied' ? 'Mailloom was not allowed.' : 'Could not connect Mailloom. Start again from Settings.');
  }
}

export const connectEnabled = () => connectConfig() !== null && !!appBaseUrl();

function need(): ConnectConfig {
  const c = connectConfig();
  if (!c || !appBaseUrl()) throw new SafeError('Connect Mailloom is not set up on this Work OS. Paste a key instead.');
  return c;
}

/** The exact redirect URI registered in Mailloom (AGENT_CLIENT_REDIRECT_URIS). */
export const mailRedirectUri = () => `${appBaseUrl()}${MAILLOOM_CONNECT.callbackPath}`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64u = (b: Buffer) => b.toString('base64url');
const verifierContext = (id: string, c: Scope) => `mail-connect:${id}:${c.orgId}:${c.userId}`;

async function pending() {
  return (await collections()).mailConnectAuth; // scope-ok: Connect Mailloom requests, always keyed by the caller's organization, user and session
}

/** The id of the session these headers carry, read fresh from the database (not the cookie cache), or null. */
export async function sessionIdOf(h: Headers): Promise<string | null> {
  const s = await (await getAuth()).api.getSession({ headers: h, query: { disableCookieCache: true } }).catch(() => null);
  const id = (s?.session as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id ? id : null;
}

/** Starts Connect for the caller: the address of Mailloom's authorize page. A new start replaces the person's earlier one. */
export async function startConnect(c: Caller, sessionId: string | null): Promise<string> {
  const cfg = need();
  if (!sessionId) throw new SafeError('Sign in again, then press Connect.');
  const state = b64u(randomBytes(32));
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const id = sha(state);
  const db = await pending();
  await db.deleteMany({ orgId: c.orgId, userId: c.userId });
  await db.insertOne({ _id: id, orgId: c.orgId, userId: c.userId, sessionId, verifier: sealText(verifier, verifierContext(id, c)), expiresAt: new Date(Date.now() + AUTH_MINUTES * 60_000) });
  const u = new URL(cfg.publicUrl + MAILLOOM_CONNECT.authorizePath);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', mailRedirectUri());
  u.searchParams.set('scope', MAILLOOM_CONNECT.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // Shown on Mailloom's consent screen and in its Connections list, so a person in two organizations can tell the keys apart.
  u.searchParams.set('label', (await orgName(c.orgId).catch(() => '')).slice(0, 60) || 'Work OS');
  return u.toString();
}

async function bodyJson(res: Response): Promise<unknown> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new ConnectError('error');
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || !value) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      void reader.cancel().catch(() => {});
      throw new ConnectError('error');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

type Minted = { key: string; keyId: string; email: string; scopes: string[] };

/** The code-for-key swap. Any refusal or odd reply is ConnectError('error'); nothing of the reply is logged or shown. */
async function swap(cfg: ConnectConfig, code: string, verifier: string, ids: Ids): Promise<Minted> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: mailRedirectUri(), code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  let res: Response;
  try {
    res = await fetch(cfg.agentBase + MAILLOOM_CONNECT.tokenPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ConnectError('error');
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    throw new ConnectError('error');
  }
  const t = (await bodyJson(res)) as Record<string, unknown> | null;
  const key = typeof t?.key === 'string' ? t.key : '';
  const email = typeof t?.email === 'string' ? t.email.trim().toLowerCase() : '';
  const scopes = Array.isArray(t?.scopes) ? t.scopes.filter((x): x is string => typeof x === 'string') : [];
  if (!looksLikeKey(key)) throw new ConnectError('error');
  const bad = async () => {
    await revokeKey(key, ids);
    return new ConnectError('error');
  };
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw await bad();
  // Granted scopes are what Mailloom says, never more than Work OS asked for; read is required (every mail tool needs it).
  if (!scopes.every(x => KNOWN_SCOPES.has(x)) || !scopes.includes('read')) throw await bad();
  const keyId = typeof t?.key_id === 'string' ? t.key_id.slice(0, 100) : '';
  return { key, keyId, email, scopes: MAILLOOM_CONNECT.scopes.filter(x => scopes.includes(x)) };
}

/** Checks Mailloom's `iss` (RFC 9207) when it sends one: it must name Mailloom's public address. */
function issOk(cfg: ConnectConfig, iss: string | null): boolean {
  if (iss === null) return true;
  const v = iss.replace(/\/+$/, '');
  return v === cfg.publicUrl || v === new URL(cfg.publicUrl).origin;
}

/**
 * The callback: the state must be this person's, in this organization and this session, unused and not expired;
 * then the code is swapped (client secret + PKCE verifier), the new key checked with whoami, stored sealed, and the key
 * it replaces revoked at Mailloom. oldRevoked: null (there was none), true, or false (the person is told).
 */
export async function completeConnect(c: Caller, sessionId: string | null, q: { code: string | null; state: string | null; error: string | null; iss: string | null }): Promise<{ oldRevoked: boolean | null }> {
  const cfg = need();
  const state = q.state ?? '';
  if (!STATE_SHAPE.test(state)) throw new ConnectError('error');
  const id = sha(state);
  const row = await (await pending()).findOneAndDelete({ _id: id }); // single use, whatever happens next
  if (!row || !sessionId || row.userId !== c.userId || row.orgId !== c.orgId || row.sessionId !== sessionId || row.expiresAt.getTime() < Date.now()) throw new ConnectError('error');
  if (!issOk(cfg, q.iss)) throw new ConnectError('error');
  if (q.error) throw new ConnectError(q.error === 'access_denied' ? 'denied' : 'error');
  const code = q.code ?? '';
  if (!code || code.length > 500) throw new ConnectError('error');
  const verifier = unsealText(row.verifier, verifierContext(id, c));
  if (!verifier) throw new ConnectError('error');
  const ids: Ids = { user: c.userId, session: `wos-connect-${randomUUID()}` };
  const minted = await swap(cfg, code, verifier, ids);
  // The new key must open the mailbox the swap named (a broken or mixed-up answer is refused, and the key revoked).
  const me = await whoami(minted.key, ids).catch(() => null);
  if (!me || typeof me.email !== 'string' || me.email.toLowerCase() !== minted.email) {
    await revokeKey(minted.key, ids);
    throw new ConnectError('error');
  }
  const old = await storedKeyOf(c);
  const now = new Date();
  await setUserSetting(c, 'mail', { mail: { sealed: sealMailKey(minted.key, c), prefix: minted.key.slice(0, 8), email: minted.email, savedAt: now, scopes: minted.scopes, keyId: minted.keyId, via: 'connect' }, updatedAt: now });
  return { oldRevoked: old && old !== minted.key ? await revokeKey(old, ids) : null };
}

/**
 * A member leaves an organization (lib/members.ts): their Mailloom key for it revokes itself at Mailloom (best effort,
 * not waited for) and their Connect requests there go. The caller deletes the setting itself.
 */
export async function dropMailKey(orgId: string, userId: string): Promise<void> {
  const s: Scope = { orgId, userId };
  await (await pending()).deleteMany({ orgId, userId });
  const key = await storedKeyOf(s);
  if (key) void revokeKey(key, { user: userId, session: `wos-member-removed-${randomUUID()}` });
}
