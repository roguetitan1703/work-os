'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { setChecklistHidden } from '@/lib/get-started';

// Hide or bring back the first-run checklist. It is the signed-in person's own preference (their profile settings);
// nothing else is read or written, and nothing else (MCP, Discord) can reach it.

type R = { ok: true } | { ok: false; error: string };

async function set(hidden: boolean): Promise<R> {
  try {
    await setChecklistHidden(await requireCaller(), hidden);
    revalidatePath('/today');
    revalidatePath('/settings');
    return { ok: true };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('checklist action failed', e instanceof Error ? e.name : e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function hideChecklistAction(): Promise<R> {
  return set(true);
}

export async function showChecklistAction(): Promise<R> {
  return set(false);
}
