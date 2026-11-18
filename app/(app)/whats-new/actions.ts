'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { markWhatsNewSeen } from '@/lib/whats-new-seen';

// Mark What's new entries seen: one (`id`) or all (no id). The signed-in person's own preference in their profile
// settings; requireCaller reads the session cookie, so no API key, MCP tool or Discord command reaches it.

type R = { ok: true } | { ok: false; error: string };

export async function markWhatsNewSeenAction(id?: string): Promise<R> {
  try {
    await markWhatsNewSeen(await requireCaller(), typeof id === 'string' ? id : undefined);
    // The nav dot lives in the layout.
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('whats-new action failed', e instanceof Error ? e.name : e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
