'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { asCaller } from '@/lib/caller';
import { startLink, unlink } from '@/lib/delpat-os';

// Settings › Connections › Delpat OS: link (returns the Delpat OS sign-in address) and unlink. Each acts on the caller's own link.

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(what: string, fn: () => Promise<T>): Promise<R<T>> {
  try {
    const data = await fn();
    revalidatePath('/settings');
    return { ok: true, data };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error(`${what} failed`, e instanceof Error ? e.name : 'error');
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function startDelpatOsLinkAction(): Promise<R<{ url: string }>> {
  return run('delpat os link', () => asCaller(async c => ({ url: await startLink(c) })));
}

export async function unlinkDelpatOsAction(): Promise<R<null>> {
  return run('delpat os unlink', () => asCaller(async c => void (await unlink(c))).then(() => null));
}
