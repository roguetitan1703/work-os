'use server';

import { SafeError } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { confirmPassword } from '@/lib/fresh';

// The password re-entry behind components/reauth.tsx (lib/fresh.ts): marks the session fresh for 10 minutes.

export async function confirmPasswordAction(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await confirmPassword(await requireCaller(), String(password ?? ''));
    return { ok: true };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('confirm password failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
