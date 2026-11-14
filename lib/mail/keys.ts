import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { authSecret } from '../auth';
import { InputError } from '../data/errors';
import { getUserSetting, setUserSetting, type Scope } from '../scope';
import { looksLikeKey, MailError, whoami, type Ids, type Whoami } from './client';

// Each person's own Mailloom agent key (Mailloom › Connections › New key), stored sealed in `settings` `mail:<userId>`.
// AES-256-GCM, key derived (HKDF) from MAIL_KEY_SECRET or else BETTER_AUTH_SECRET; the ciphertext is bound to the
// organization and person (AAD), so a copied document opens for nobody else. Only the prefix (first 8 characters) and
// the mailbox address are kept in clear. Every MCP call reads the key of the CALLER's own scope, never anyone else's.

const SETUP = 'Link your mailbox in Settings › Connections › Mail.';

function sealKey(): Buffer {
  const ikm = process.env.MAIL_KEY_SECRET?.trim() || authSecret();
  if (!ikm) throw new InputError('Mail is not set up on this Work OS (no secret to protect keys with).');
  return Buffer.from(hkdfSync('sha256', ikm, 'work-os', 'mailloom-agent-keys-v1', 32));
}

const aad = (s: Pick<Scope, 'orgId' | 'userId'>) => Buffer.from(`mail-key:${s.orgId}:${s.userId}`);

export function sealMailKey(plain: string, s: Scope): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  c.setAAD(aad(s));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function unsealMailKey(sealed: string, s: Scope): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'));
    d.setAAD(aad(s));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export type MailLink = { prefix: string; email: string; savedAt: string };

/** What Settings shows: the prefix and mailbox of the person's own key, or null. Never the key. */
export async function mailLinkOf(s: Scope): Promise<MailLink | null> {
  const m = (await getUserSetting(s, 'mail'))?.mail;
  return m?.sealed ? { prefix: m.prefix, email: m.email, savedAt: m.savedAt.toISOString() } : null;
}

/** The person's own key (and mailbox address), or the plain "link your mailbox" message. */
export async function mailKeyOf(s: Scope): Promise<{ key: string; email: string }> {
  const m = (await getUserSetting(s, 'mail'))?.mail;
  if (!m?.sealed) throw new InputError(SETUP);
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
  const link = { sealed: sealMailKey(key, s), prefix: key.slice(0, 8), email: me.email.toLowerCase(), savedAt: new Date() };
  await setUserSetting(s, 'mail', { mail: link, updatedAt: new Date() });
  return { prefix: link.prefix, email: link.email, savedAt: link.savedAt.toISOString() };
}

export async function removeMailKey(s: Scope): Promise<void> {
  await setUserSetting(s, 'mail', { mail: null, updatedAt: new Date() });
}

/** The Test button: asks Mailloom who the saved key is. */
export async function testMailKey(s: Scope, ids: Ids): Promise<Whoami> {
  const { key } = await mailKeyOf(s);
  return whoami(key, ids);
}
