'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z, ZodError } from 'zod';
import { SESSION_COOKIE, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { InputError, NotFoundError } from '@/lib/data/errors';
import { getDispatcherSettings, giveToClaude, listNotePicks, markOptions, setDispatcherSettings, takeBackFromClaude, type DispatcherSettings, type MarkOptions, type NotePick } from '@/lib/data/dispatcher';

// Task dispatcher actions (docs/dispatcher.md). These are the ONLY way to mark or unmark a task for
// Claude: they check Om's session cookie, and nothing reachable from MCP, Discord or apply_changes calls them.

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>, revalidate = true): Promise<R<T>> {
  try {
    if (!uiAuthDisabled() && !(await verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value))) throw new InputError('Not signed in');
    const data = await fn();
    if (revalidate) revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => i.message).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error('[dispatcher action]', err);
    return { ok: false, error: 'Something went wrong' };
  }
}

const Key = z.string().min(1).max(60);

export async function markOptionsAction(taskKey: string): Promise<R<MarkOptions>> {
  return run(() => markOptions(Key.parse(taskKey)), false);
}

export async function giveToClaudeAction(taskKey: string, folderKey?: string): Promise<R<null>> {
  return run(async () => {
    await giveToClaude(Key.parse(taskKey), folderKey === undefined ? undefined : z.string().min(1).max(120).parse(folderKey));
    return null;
  });
}

export async function takeBackFromClaudeAction(taskKey: string, stop?: boolean): Promise<R<null>> {
  return run(async () => {
    await takeBackFromClaude(Key.parse(taskKey), { stop: stop === true });
    return null;
  });
}

export async function dispatcherSettingsAction(patch: { enabled?: boolean; maxConcurrent?: number; boilerplateNoteId?: string }): Promise<R<DispatcherSettings>> {
  return run(() =>
    setDispatcherSettings(
      z.object({ enabled: z.boolean().optional(), maxConcurrent: z.number().int().optional(), boilerplateNoteId: z.string().max(60).optional() }).strict().parse(patch),
    ),
  );
}

export async function dispatcherSetupAction(): Promise<R<{ settings: DispatcherSettings; notes: NotePick[] }>> {
  return run(async () => ({ settings: await getDispatcherSettings(), notes: await listNotePicks() }), false);
}
