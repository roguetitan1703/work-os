import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { authSecret, MIN_SECRET } from '../auth';
import { InputError } from '../data/errors';
import { getUserSetting, setUserSetting, type Scope } from '../scope';
import { looksLikeKey, MailError, revokeKey, whoami, type Ids, type Whoami } from './client';

// Each person's own Mailloom agent key (Mailloom › Connections › New key), stored sealed in `settings` `mail:<userId>`.
// AES-256-GCM, key derived (HKDF) from MAIL_KEY_SECRET or else BETTER_AUTH_SECRET; the ciphertext is bound to the
// organization and person (AAD), so a copied document opens for nobody else. Only the prefix (first 8 characters) and
// the mailbox address are kept in clear. Every MCP call reads the key of the CALLER's own scope, never anyone else's.

const SETUP = 'Link your mailbox in Settings › Connections › Mail.';

function sealKey(): Buffer {
  const own = process.env.MAIL_KEY_SECRET?.trim();
  if (own && own.length < MIN_SECRET) throw new InputError('MAIL_KEY_SECRET is too short');
  const ikm = own || authSecret();
  if (!ikm) throw new InputError('Mail is not set up on this Work OS (no secret to protect keys with).');
  return Buffer.from(hkdfSync('sha256', ikm, 'work-os', 'mailloom-agent-keys-v1', 32));
}

const aad = (s: Pick<Scope, 'orgId' | 'userId'>) => `mail-key:${s.orgId}:${s.userId}`;

/** AES-256-GCM under the mail key secret, bound to `context` (also seals Connect's PKCE verifier, lib/mail/connect.ts). */
export function sealText(plain: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(context));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function unsealText(sealed: string, context: string): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    const t = Buffer.from(tag, 'base64url');
    if (t.length !== 16) return null;
    d.setAAD(Buffer.from(context));
    d.setAuthTag(t);
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const sealMailKey = (plain: string, s: Scope): string => sealText(plain, aad(s));
export const unsealMailKey = (sealed: string, s: Scope): string | null => unsealText(sealed, aad(s));

export type MailLink = { prefix: string; email: string; savedAt: string; scopes: string[] | null; via: 'connect' | 'paste' };

/** What Settings shows: the prefix, mailbox and (for a connected key) granted scopes of the person's own key, or null. Never the key. */
export async function mailLinkOf(s: Scope): Promise<MailLink | null> {
  const m = (await getUserSetting(s, 'mail'))?.mail;
  return m?.sealed ? { prefix: m.prefix, email: m.email, savedAt: m.savedAt.toISOString(), scopes: m.scopes ?? null, via: m.via === 'connect' ? 'connect' : 'paste' } : null;
}

/** The person's saved key in clear, or null (none, or it cannot be opened). Only for revoking it at Mailloom. */
export async function storedKeyOf(s: Scope): Promise<string | null> {
  const m = (await getUserSetting(s, 'mail'))?.mail;
  if (!m?.sealed) return null;
  try {
    return unsealMailKey(m.sealed, s);
  } catch {
    return null; // no usable secret: nothing to revoke with
  }
}

/** The person's own key (and mailbox address), or the plain "link your mailbox" message. */
export async function mailKeyOf(s: Scope): Promise<{ key: string; email: string }> {
  const m = (await getUserSetting(s, 'mail'))?.mail;
  if (!m?.sealed) throw new InputError(SETUP);
  sealKey(); // a too-short MAIL_KEY_SECRET says so, instead of looking like a broken key
  const key = unsealMailKey(m.sealed, s);
  if (!key) throw new InputError(`Your saved Mailloom key could not be opened. ${SETUP}`);
  return { key, email: m.email };
}

/** Checks a pasted key with Mailloom (whoami), then stores it sealed. Returns what Settings shows. */
export async function saveMailKey(s: Scope, pasted: string, ids: Ids): Promise<MailLink> {
  const key = pasted.trim();
  if (!looksLikeKey(key)) throw new InputError('That is not a Mailloom key. It starts with mlk_ and is 47 characters long.');
  const me = await whoami(key, ids);
  if (!me?.email || typeof me.email !== 'string') throw new MailError('Mailloom did not say which mailbox the key opens.', 0, 'BAD_RESPONSE');
  const old = await storedKeyOf(s);
  const link = { sealed: sealMailKey(key, s), prefix: key.slice(0, 8), email: me.email.toLowerCase(), savedAt: new Date(), via: 'paste' as const };
  await setUserSetting(s, 'mail', { mail: link, updatedAt: new Date() });
  if (old && old !== key) await revokeKey(old, ids); // the replaced key; best effort
  return { prefix: link.prefix, email: link.email, savedAt: link.savedAt.toISOString(), scopes: null, via: 'paste' };
}

/**
 * Disconnect: the key revokes itself at Mailloom, then the setting is deleted either way. revoked is null when there
 * was no key, false when Mailloom could not be reached (the person is told to revoke it in Mailloom › Connections).
 */
export async function removeMailKey(s: Scope, ids: Ids): Promise<{ revoked: boolean | null }> {
  const key = await storedKeyOf(s);
  const revoked = key ? await revokeKey(key, ids) : null;
  await setUserSetting(s, 'mail', { mail: null, updatedAt: new Date() });
  return { revoked };
}

/** The Test button: asks Mailloom who the saved key is. */
export async function testMailKey(s: Scope, ids: Ids): Promise<Whoami> {
  const { key } = await mailKeyOf(s);
  return whoami(key, ids);
}
