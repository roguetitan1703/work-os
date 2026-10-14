'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { setBlockedIds } from '@/lib/discord/client';
import { SESSION_COOKIE, SafeError, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, type ApiKeyInfo } from '@/lib/api-keys';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  await setBlockedIds(ids);
  revalidatePath('/connect');
}

// ── Claude Code keys ────────────────────────────────────────────────────────
// Every action re-checks the session cookie (proxy.ts already does; this is belt and braces
// because these create credentials).

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    if (!uiAuthDisabled() && !(await verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value))) throw new SafeError('Not signed in.');
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('api key action failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function listApiKeysAction(): Promise<R<ApiKeyInfo[]>> {
  return run(listApiKeys);
}

/** Returns the new key in full: the only time it is ever shown. */
export async function createApiKeyAction(name: string): Promise<R<{ key: string; keys: ApiKeyInfo[] }>> {
  return run(async () => {
    const { key } = await createApiKey(String(name ?? ''));
    return { key, keys: await listApiKeys() };
  });
}

export async function rotateApiKeyAction(id: string): Promise<R<{ key: string; keys: ApiKeyInfo[] }>> {
  return run(async () => {
    const { key } = await rotateApiKey(String(id));
    return { key, keys: await listApiKeys() };
  });
}

export async function revokeApiKeyAction(id: string): Promise<R<ApiKeyInfo[]>> {
  return run(async () => {
    await revokeApiKey(String(id));
    return listApiKeys();
  });
}
