'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { answerNeed, type Need } from '@/lib/data/needs';
import { InputError, NotFoundError } from '@/lib/data/errors';

type Result = { ok: true; need: Need } | { ok: false; error: string };

/**
 * Answer a Need: the app is the only place (plus, later, the addressed person's own Discord button). The caller must be
 * the person it is addressed to: answerNeed reads it through their own scope, so anyone else gets "not found".
 * No MCP tool, key or OAuth client reaches this: it needs the signed-in session (requireCaller reads the session cookie).
 */
export async function answerNeedAction(id: string, option: string, text?: string): Promise<Result> {
  try {
    const caller = await requireCaller();
    const need = await withCaller(caller, () => answerNeed({ userId: caller.userId, orgId: caller.orgId }, String(id), { option: String(option), text: typeof text === 'string' ? text : undefined }, 'app'));
    revalidatePath('/', 'layout');
    return { ok: true, need };
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}
