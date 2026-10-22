'use server';

import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { getItem, LIMITS, moveItem, omUpdate, type OmPatch } from '@/lib/data/claude-items';
import { CLAUDE_ITEM_KINDS, CLAUDE_ITEM_STATES, type ClaudeItem } from '@/lib/types';
import { InputError, NotFoundError } from '@/lib/data/errors';

// item: the item as saved, so the open sheet can show it even if the page refresh arrives late.
type Result = { ok: true; item?: ClaudeItem } | { ok: false; error: string };

// Same shape as run() in app/actions.ts, but revalidates just the project page.
async function run(projectId: string, fn: () => Promise<ClaudeItem | null | void>): Promise<Result> {
  try {
    const caller = await requireCaller();
    const item = await withCaller(caller, fn);
    revalidatePath('/', 'layout');
    return { ok: true, item: item ?? undefined };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

async function ownItem(projectId: string, key: string) {
  const item = await getItem(key);
  if (!item || item.projectId !== projectId) throw new NotFoundError('Claude item not found');
}

const PatchSchema = z
  .object({
    state: z.enum(CLAUDE_ITEM_STATES).optional(),
    next: z.boolean().optional(),
    waitingOnOm: z.string().max(LIMITS.waiting).optional(),
    kind: z.enum(CLAUDE_ITEM_KINDS).optional(),
    title: z.string().min(1).max(LIMITS.title).optional(),
    why: z.string().max(LIMITS.why).optional(),
    doneWhen: z.string().max(LIMITS.doneWhen).optional(),
    note: z.string().max(LIMITS.note).optional(),
  })
  .strict();

export async function updateClaudeItemAction(projectId: string, key: string, patch: OmPatch): Promise<Result> {
  return run(projectId, async () => {
    await ownItem(projectId, key);
    return omUpdate(key, PatchSchema.parse(patch));
  });
}

/** hops: how many places to move (the list shows groups, so one visible step can be several places in the project order). */
export async function moveClaudeItemAction(projectId: string, key: string, dir: 'up' | 'down' | 'top', hops = 1): Promise<Result> {
  return run(projectId, async () => {
    await ownItem(projectId, key);
    await moveItem(key, z.enum(['up', 'down', 'top']).parse(dir), z.number().int().min(1).max(50).catch(1).parse(hops));
    return getItem(key);
  });
}
