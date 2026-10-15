'use server';

import { cookies } from 'next/headers';
import { SESSION_COOKIE, SafeError, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, type ApiKeyInfo } from '@/lib/api-keys';
import { createDevice, listDevices, revokeDevice, type DeviceInfo } from '@/lib/devices';

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

// ── Devices (session launcher) ──────────────────────────────────────────────

export async function listDevicesAction(): Promise<R<DeviceInfo[]>> {
  return run(listDevices);
}

export async function createDeviceAction(name: string): Promise<R<{ key: string; devices: DeviceInfo[] }>> {
  return run(async () => {
    const { key } = await createDevice(String(name ?? ''));
    return { key, devices: await listDevices() };
  });
}

export async function revokeDeviceAction(id: string): Promise<R<DeviceInfo[]>> {
  return run(async () => {
    await revokeDevice(String(id));
    return listDevices();
  });
}
