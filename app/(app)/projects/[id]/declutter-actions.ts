'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { scoped, type Scope } from '@/lib/scope';
import { InputError, NotFoundError } from '@/lib/data/errors';
import { resolveProject } from '@/lib/data/projects';
import { buildProposal } from '@/lib/data/declutter';
import { applyDeclutter, mayDeclutter } from '@/lib/data/declutter-apply';
import type { DeclutterItem } from '@/lib/declutter-core';

// The project's ⋯ › Declutter (docs/flows/agent-system.md section 7, "also on demand from the app"): the person sees the same
// proposal an agent's Need carries and applies the ticked changes directly, no Need. Only the project's owner or an owner of the
// organization may: what Declutter withdraws, archives and finishes is the owner's call, as with a declutter Need (it goes to
// the owner). The proposal is built again on the server for the apply, as the caller: the browser sends only item ids, never text
// or targets, so an id pasted from another project matches nothing.

export type ProposalResult = { ok: true; items: DeclutterItem[]; fyi: string[] } | { ok: false; error: string };
export type ApplyResult = { ok: true; applied: number; failed: string[] } | { ok: false; error: string };

async function owned(projectId: string) {
  const caller = await requireCaller();
  const s: Scope = { userId: caller.userId, orgId: caller.orgId };
  const c = await scoped(s);
  const project = await resolveProject(c, s, String(projectId), { create: false });
  if (!project) throw new NotFoundError('Project not found');
  if (!(await mayDeclutter(s, project))) throw new InputError("Only the project's owner or an owner of the organization can declutter it.");
  return { caller, s, project };
}

function fail(err: unknown): { ok: false; error: string } {
  if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
  console.error(err);
  return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
}

export async function declutterProposalAction(projectId: string): Promise<ProposalResult> {
  try {
    const { caller, s, project } = await owned(projectId);
    const p = await withCaller(caller, () => buildProposal(s, project));
    return { ok: true, items: p.items, fyi: p.fyi };
  } catch (err) {
    return fail(err);
  }
}

export async function applyDeclutterAction(projectId: string, ids: string[]): Promise<ApplyResult> {
  try {
    const { caller, s, project } = await owned(projectId);
    const want = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (!want.size) throw new InputError('Tick at least one change.');
    const r = await withCaller(caller, async () => {
      const p = await buildProposal(s, project);
      return applyDeclutter(s, project, p.items.filter(i => want.has(i.id)));
    });
    revalidatePath(`/projects/${project._id}`);
    revalidatePath('/', 'layout');
    return { ok: true, applied: r.applied.length, failed: r.failed };
  } catch (err) {
    return fail(err);
  }
}
