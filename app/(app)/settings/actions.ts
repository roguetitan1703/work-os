'use server';

import { revalidatePath } from 'next/cache';
import {
  addToInbox,
  getNotifySettings,
  markAllRead,
  removePushSubscription,
  savePushSubscription,
  sendPush,
  setNotifySettings,
  type NotifySettings,
  type PushSubJSON,
} from '@/lib/notify';
import { sendDm } from '@/lib/alerts';
import { discordConfig } from '@/lib/discord/client';

type R = { ok: true; detail?: string } | { ok: false; error: string };
const fail = (e: unknown): R => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function subscribePushAction(sub: PushSubJSON, device: string): Promise<R> {
  try {
    await savePushSubscription(sub, device);
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function unsubscribePushAction(endpoint: string): Promise<R> {
  try {
    await removePushSubscription(endpoint);
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveNotifySettingsAction(next: NotifySettings): Promise<R> {
  try {
    await setNotifySettings(next);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Sends a test through every enabled channel and reports what happened. */
export async function testNotificationAction(): Promise<R> {
  try {
    const s = await getNotifySettings();
    const parts: string[] = [];
    await addToInbox([{ kind: 'test', title: 'Test notification', body: 'If you can read this, notifications work.', url: '/notifications' }]);
    parts.push('inbox ✓');
    if (s.channels.push) {
      const r = await sendPush({ title: 'Work OS', body: 'Test notification: it works.', url: '/notifications', tag: 'test' });
      parts.push(r.error ? `phone: ${r.error}` : `phone: ${r.sent} device${r.sent === 1 ? '' : 's'}`);
    }
    if (s.channels.discord && discordConfig()) {
      try {
        await sendDm('🔔 Test notification from Work OS: it works.');
        parts.push('Discord ✓');
      } catch (e) {
        parts.push(`Discord: ${e instanceof Error ? e.message : e}`);
      }
    }
    revalidatePath('/notifications');
    return { ok: true, detail: parts.join(' · ') };
  } catch (e) {
    return fail(e);
  }
}

export async function markAllReadAction(): Promise<void> {
  await markAllRead();
  revalidatePath('/', 'layout');
}
