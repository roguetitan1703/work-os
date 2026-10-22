'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  NOTIFY_KINDS,
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
import { asCaller } from '@/lib/caller';
import { getProfile } from '@/lib/profile';

// Every action requires a signed-in caller (lib/caller.ts); proxy.ts is only the first gate.

type R = { ok: true; detail?: string } | { ok: false; error: string };
const fail = (e: unknown): R => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function subscribePushAction(sub: PushSubJSON, device: string): Promise<R> {
  try {
    await asCaller(c => savePushSubscription(c, sub, device));
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function unsubscribePushAction(endpoint: string): Promise<R> {
  try {
    await asCaller(c => removePushSubscription(c, endpoint));
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const NotifyIn = z.object({
  channels: z.object({ push: z.boolean(), discord: z.boolean() }),
  kinds: z.object(Object.fromEntries(NOTIFY_KINDS.map(k => [k.kind, z.boolean()]))),
});

export async function saveNotifySettingsAction(next: NotifySettings): Promise<R> {
  try {
    await asCaller(c => setNotifySettings(c, NotifyIn.parse(next) as NotifySettings));
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Sends a test through every enabled channel and reports what happened. */
export async function testNotificationAction(): Promise<R> {
  try {
    const c = await asCaller(async c => c);
    const s = await getNotifySettings(c);
    const parts: string[] = [];
    await addToInbox(c, [{ kind: 'test', title: 'Test notification', body: 'If you can read this, notifications work.', url: '/notifications' }]);
    parts.push('inbox ✓');
    if (s.channels.push) {
      const r = await sendPush(c, { title: 'Work OS', body: 'Test notification: it works.', url: '/notifications', tag: 'test' });
      parts.push(r.error ? `phone: ${r.error}` : `phone: ${r.sent} device${r.sent === 1 ? '' : 's'}`);
    }
    // The Discord DM goes to the caller's own linked account (lib/profile.ts).
    const discordId = (await getProfile(c)).discordId;
    if (s.channels.discord && discordConfig() && discordId) {
      try {
        await sendDm(discordId, '🔔 Test notification from Work OS: it works.');
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
  await asCaller(c => markAllRead(c));
  revalidatePath('/', 'layout');
}
