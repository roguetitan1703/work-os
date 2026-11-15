'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { SafeError } from '@/lib/auth';
import { asCaller } from '@/lib/caller';
import { InputError } from '@/lib/data/errors';
import { MailError } from '@/lib/mail/client';
import { sessionIdOf, startConnect } from '@/lib/mail/connect';
import { removeMailKey, saveMailKey, testMailKey, type MailLink } from '@/lib/mail/keys';

// Settings › Connections › Mail: Connect Mailloom (lib/mail/connect.ts), or paste your own Mailloom key; test it; disconnect
// (revokes it at Mailloom). Each acts on the caller's own key.

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(what: string, fn: () => Promise<T>): Promise<R<T>> {
  try {
    const data = await fn();
    revalidatePath('/settings');
    return { ok: true, data };
  } catch (e) {
    if (e instanceof SafeError || e instanceof InputError || e instanceof MailError) return { ok: false, error: e.message };
    console.error(`${what} failed`, e instanceof Error ? e.name : 'error');
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

const ids = (userId: string) => ({ user: userId, session: `wos-settings-${randomUUID()}` });

export async function saveMailKeyAction(key: string): Promise<R<MailLink>> {
  return run('mail key save', () => asCaller(async c => saveMailKey(c, String(key ?? ''), ids(c.userId))));
}

export async function testMailKeyAction(): Promise<R<{ email: string; prefix: string; scopes: string[] }>> {
  return run('mail key test', () =>
    asCaller(async c => {
      const w = await testMailKey(c, ids(c.userId));
      return { email: w.email, prefix: w.key.prefix, scopes: w.key.scopes };
    }),
  );
}

/** Disconnect: the key revokes itself at Mailloom, then is deleted here either way. revoked false: tell the person to revoke it in Mailloom. */
export async function removeMailKeyAction(): Promise<R<{ revoked: boolean | null }>> {
  return run('mail key remove', () => asCaller(async c => removeMailKey(c, ids(c.userId))));
}

/** Connect Mailloom: the address of Mailloom's authorize page (state and PKCE challenge in it); the button navigates there. */
export async function startMailConnectAction(): Promise<R<{ url: string }>> {
  return run('mail connect', () => asCaller(async c => ({ url: await startConnect(c, await sessionIdOf(await headers())) })));
}
