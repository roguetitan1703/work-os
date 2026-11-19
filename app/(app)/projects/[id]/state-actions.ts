'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import { memberNames } from '@/lib/people';
import { withLaneMarks } from '@/lib/data/roster';
import { archivedOut, restoreLine, saveState, stateOut, type ArchivedOut, type StateOut } from '@/lib/data/states';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The State card's writes: the same versioned save as the MCP tool (lib/data/states.ts), as the signed-in person.
// A stale base_version writes nothing and returns the current State, which the card shows.

export type StateResult = { ok: true; state: StateOut } | { ok: false; error: string; conflict?: true; state?: StateOut | null };

export async function saveStateAction(projectId: string, ops: unknown, baseVersion?: number): Promise<StateResult> {
  try {
    const caller = await requireCaller();
    const s = { userId: caller.userId, orgId: caller.orgId };
    const r = await withCaller(caller, () => saveState(s, projectId, ops, { baseVersion, actor: userActor(caller.userId), via: 'app' }));
    const names = await memberNames(caller.orgId);
    revalidatePath(`/projects/${projectId}`);
    if (r.conflict) return { ok: false, conflict: true, error: 'Someone changed the State since you opened it. It is refreshed: try again.', state: r.state ? await withLaneMarks(s, projectId, r.state, stateOut(r.state, caller.userId, names)) : null };
    return { ok: true, state: await withLaneMarks(s, projectId, r.state, stateOut(r.state, caller.userId, names)) };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

export type RestoreResult = { ok: true; state: StateOut; archived: ArchivedOut[] } | { ok: false; error: string };

/**
 * Puts an archived line back at the end of Later. A person only: the caller's own door reads the State (a project they cannot
 * read is "not found"), and restoreLine refuses an agent actor.
 */
export async function restoreLineAction(projectId: string, archivedId: string): Promise<RestoreResult> {
  try {
    const caller = await requireCaller();
    const s = { userId: caller.userId, orgId: caller.orgId };
    const r = await withCaller(caller, () => restoreLine(s, String(projectId), String(archivedId), userActor(caller.userId)));
    const names = await memberNames(caller.orgId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, state: await withLaneMarks(s, projectId, r.state, stateOut(r.state, caller.userId, names)), archived: archivedOut(r.state, names) };
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}
