'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { InputError } from '@/lib/data/errors';
import { savePlanReset } from '@/lib/data/claude-usage';

// Claude › Usage: the person's plan week start. Acts on the caller's own setting only.

export type UsageResetResult = { ok: true } | { ok: false; error: string };

export async function savePlanResetAction(_prev: UsageResetResult | null, form: FormData): Promise<UsageResetResult> {
  try {
    const c = await requireCaller();
    await withCaller(c, () => savePlanReset(c, { weekday: Number(form.get('weekday')), time: String(form.get('time') ?? ''), tz: String(form.get('tz') ?? '') }));
    revalidatePath('/claude');
    return { ok: true };
  } catch (e) {
    if (e instanceof SafeError || e instanceof InputError) return { ok: false, error: e.message };
    console.error('plan reset failed', e instanceof Error ? e.name : e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
