'use server';

import { SafeError } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { mailErrorMessage, missingMailEnv, sendMail, takeMailSlot } from '@/lib/mail';

// Settings › Security actions that are not Better Auth calls (those go through lib/auth-client.ts).

type R<T> = { ok: true; data: T } | { ok: false; error: string };

/** Sends a test email to the signed-in person's own address. */
export async function sendTestEmailAction(): Promise<R<string>> {
  try {
    const c = await requireCaller();
    const missing = missingMailEnv();
    if (missing.length) throw new SafeError(`Email is not set up. Missing: ${missing.join(', ')}.`);
    if (!(await takeMailSlot('test', c.email))) throw new SafeError('Too many test emails. Try again in an hour.');
    try {
      await sendMail({ to: c.email, subject: 'Work OS test email', text: 'This is a test from Work OS (Settings › Security). Password reset links will reach you here.' });
    } catch (e) {
      throw new SafeError(mailErrorMessage(e));
    }
    return { ok: true, data: c.email };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('test email failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

/** Hides the "re-create your keys and re-link the worker" notice left by scripts/migrate-auth.mjs. */
export async function dismissMigrationNoticeAction(): Promise<R<null>> {
  try {
    await requireCaller('owner', 'admin');
    const { collections } = await import('@/lib/db');
    await (await collections()).settings.updateOne({ _id: 'authMigration' }, { $set: { dismissedAt: new Date() } });
    return { ok: true, data: null };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('dismiss notice failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
