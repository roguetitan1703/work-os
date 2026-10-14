'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { ZodError } from 'zod';
import { SESSION_COOKIE, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { getItem, moveItem, omUpdate, type OmPatch } from '@/lib/data/claude-items';
import { InputError, NotFoundError } from '@/lib/data/errors';

type Result = { ok: true } | { ok: false; error: string };

// Same shape as run() in app/actions.ts, but revalidates just the project page.
async function run(projectId: string, fn: () => Promise<unknown>): Promise<Result> {
  try {
    if (!uiAuthDisabled()) {
      const value = (await cookies()).get(SESSION_COOKIE)?.value;
      if (!(await verifySessionValue(value))) throw new Error('Not signed in');
    }
    await fn();
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof Error && err.message === 'Not signed in' ? err.message : 'Something went wrong' };
  }
}

async function ownItem(projectId: string, key: string) {
  const item = await getItem(key);
  if (!item || item.projectId !== projectId) throw new NotFoundError('Claude item not found');
}

export async function updateClaudeItemAction(projectId: string, key: string, patch: OmPatch): Promise<Result> {
  return run(projectId, async () => {
    await ownItem(projectId, key);
    await omUpdate(key, patch);
  });
}

/** hops: how many places to move (the list shows groups, so one visible step can be several places in the project order). */
export async function moveClaudeItemAction(projectId: string, key: string, dir: 'up' | 'down' | 'top', hops = 1): Promise<Result> {
  return run(projectId, async () => {
    await ownItem(projectId, key);
    for (let n = 0; n < (dir === 'top' ? 1 : Math.min(Math.max(hops, 1), 50)); n++) await moveItem(key, dir);
  });
}
