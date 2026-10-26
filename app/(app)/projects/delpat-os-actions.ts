'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { asCaller } from '@/lib/caller';
import { InputError } from '@/lib/data/errors';
import { NotLinked, importDelpatProject, linkStatus, listDelpatProjects, type DelpatProject, type LinkStatus } from '@/lib/delpat-os';
import type { Project } from '@/lib/types';

// New project › From Delpat OS: whether it is available to this person, their Delpat OS projects, and the import.

type R<T> = { ok: true; data: T } | { ok: false; error: string; notLinked?: boolean };

async function run<T>(what: string, fn: () => Promise<T>): Promise<R<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof SafeError || e instanceof InputError) return { ok: false, error: e.message, ...(e instanceof NotLinked ? { notLinked: true } : {}) };
    console.error(`${what} failed`, e instanceof Error ? e.name : 'error');
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function delpatOsStatusAction(): Promise<R<LinkStatus>> {
  return run('delpat os status', () => asCaller(c => linkStatus(c)));
}

export async function listDelpatOsProjectsAction(): Promise<R<(DelpatProject & { workOsId: string | null })[]>> {
  return run('delpat os list', () => asCaller(c => listDelpatProjects(c)));
}

export async function importDelpatOsProjectAction(id: string, visibility: 'org' | 'private'): Promise<R<{ project: Project; created: boolean }>> {
  const r = await run('delpat os import', () => asCaller(c => importDelpatProject(c, String(id ?? ''), visibility === 'private' ? 'private' : 'org')));
  if (r.ok) revalidatePath('/', 'layout');
  return r;
}
