'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { asCaller } from '@/lib/caller';
import { scopeOf } from '@/lib/scope';
import { saveSchedule } from '@/lib/user-schedule';
import type { ScheduleBlock } from '@/lib/schedule';

// The signed-in person's own schedule (lib/user-schedule.ts). Nobody can edit anyone else's.

type R = { ok: true } | { ok: false; error: string };

function fail(e: unknown): R {
  if (e instanceof ZodError) return { ok: false, error: e.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ') };
  return { ok: false, error: e instanceof Error && e.name !== 'Error' ? e.message : 'Could not save' };
}

export async function saveScheduleAction(blocks: ScheduleBlock[], colors?: Record<string, string>): Promise<R> {
  try {
    await asCaller(c => saveSchedule(scopeOf(c), { blocks, ...(colors ? { colors } : {}) }));
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
