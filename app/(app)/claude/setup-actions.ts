'use server';

import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller, type Agent, type Caller } from '@/lib/caller';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, type ApiKeyInfo } from '@/lib/api-keys';
import { createDevice, listDevices, replaceDeviceKey, revokeDevice, type DeviceInfo } from '@/lib/devices';
import { requireFresh } from '@/lib/fresh';
import { appBaseUrl } from '@/lib/auth';
import { workerBundle } from '@/lib/worker-bundle';
import type { InstallInfo } from '@/lib/worker-install';

// ── API keys (Claude Code keys on Claude › Setup, Claude chat keys on Settings › Connections) ──
// Every action requires a signed-in caller (lib/caller.ts) and works on that caller's own keys.

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (c: Caller) => Promise<T>): Promise<R<T>> {
  try {
    const c = await requireCaller();
    return { ok: true, data: await withCaller(c, () => fn(c)) };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('api key action failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

const agentOf = (a: unknown): Agent => (a === 'claude' ? 'claude' : 'claude-code');

export async function listApiKeysAction(agent?: Agent): Promise<R<ApiKeyInfo[]>> {
  return run(c => listApiKeys(c, agentOf(agent)));
}

/** Returns the new key in full: the only time it is ever shown. */
export async function createApiKeyAction(name: string, agent?: Agent): Promise<R<{ key: string; keys: ApiKeyInfo[] }>> {
  return run(async c => {
    await requireFresh(c); // new credentials need a recent sign-in or password (lib/fresh.ts)
    const { key } = await createApiKey(c, String(name ?? ''), agentOf(agent));
    return { key, keys: await listApiKeys(c, agentOf(agent)) };
  });
}

export async function rotateApiKeyAction(id: string): Promise<R<{ key: string; keys: ApiKeyInfo[] }>> {
  return run(async c => {
    await requireFresh(c);
    const { key, info } = await rotateApiKey(c, String(id));
    return { key, keys: await listApiKeys(c, info.agent) };
  });
}

export async function revokeApiKeyAction(id: string, agent?: Agent): Promise<R<ApiKeyInfo[]>> {
  return run(async c => {
    await revokeApiKey(c, String(id));
    return listApiKeys(c, agentOf(agent));
  });
}

// ── Devices (session launcher) ──────────────────────────────────────────────

export async function listDevicesAction(): Promise<R<DeviceInfo[]>> {
  return run(c => listDevices(c));
}

/** What the install command needs: this site's address and the worker download's sha256 (no key, nothing private). */
export async function workerInstallInfoAction(): Promise<R<InstallInfo>> {
  return run(async () => {
    const b = workerBundle();
    return { server: appBaseUrl() ?? '', sha256: b.sha256, version: b.version };
  });
}

export async function createDeviceAction(name: string): Promise<R<{ key: string; devices: DeviceInfo[] }>> {
  return run(async c => {
    await requireFresh(c);
    const { key } = await createDevice(c, String(name ?? ''));
    return { key, devices: await listDevices(c) };
  });
}

/** A new key for the same computer (keeps its folders and sessions); the old key stops working now. Needs a recent sign-in. */
export async function replaceDeviceKeyAction(id: string): Promise<R<{ key: string; name: string; devices: DeviceInfo[] }>> {
  return run(async c => {
    await requireFresh(c);
    const { key, info } = await replaceDeviceKey(c, String(id));
    return { key, name: info.name, devices: await listDevices(c) };
  });
}

export async function revokeDeviceAction(id: string): Promise<R<DeviceInfo[]>> {
  return run(async c => {
    await revokeDevice(c, String(id));
    return listDevices(c);
  });
}
