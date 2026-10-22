'use server';

import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller, type Caller } from '@/lib/caller';
import { InputError, NotFoundError } from '@/lib/data/errors';
import { getDispatcherSettings, giveToClaude, listNotePicks, markOptions, setDispatcherSettings, takeBackFromClaude, type DispatcherSettings, type MarkOptions, type NotePick } from '@/lib/data/dispatcher';

// Task dispatcher actions (docs/dispatcher.md). These are the ONLY way to mark or unmark a task for
// Claude: they require a signed-in person (lib/caller.ts), and nothing reachable from MCP, Discord or apply_changes calls them.

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (c: Caller) => Promise<T>, revalidate = true): Promise<R<T>> {
  try {
    const caller = await requireCaller();
    const data = await withCaller(caller, () => fn(caller));
    if (revalidate) revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => i.message).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError || err instanceof SafeError) return { ok: false, error: err.message };
    console.error('[dispatcher action]', err);
    return { ok: false, error: 'Something went wrong' };
  }
}

const Key = z.string().min(1).max(60);

export async function markOptionsAction(taskKey: string): Promise<R<MarkOptions>> {
  return run(c => markOptions(c, Key.parse(taskKey)), false);
}

export async function giveToClaudeAction(taskKey: string, folderKey?: string): Promise<R<null>> {
  return run(async c => {
    await giveToClaude(c, Key.parse(taskKey), folderKey === undefined ? undefined : z.string().min(1).max(120).parse(folderKey));
    return null;
  });
}

export async function takeBackFromClaudeAction(taskKey: string, stop?: boolean): Promise<R<null>> {
  return run(async c => {
    await takeBackFromClaude(c, Key.parse(taskKey), { stop: stop === true });
    return null;
  });
}

export async function dispatcherSettingsAction(patch: { enabled?: boolean; maxConcurrent?: number; boilerplateNoteId?: string }): Promise<R<DispatcherSettings>> {
  return run(c =>
    setDispatcherSettings(
      c,
      z.object({ enabled: z.boolean().optional(), maxConcurrent: z.number().int().optional(), boilerplateNoteId: z.string().max(60).optional() }).strict().parse(patch),
    ),
  );
}

export async function dispatcherSetupAction(): Promise<R<{ settings: DispatcherSettings; notes: NotePick[] }>> {
  return run(async c => ({ settings: await getDispatcherSettings(c), notes: await listNotePicks(c) }), false);
}
