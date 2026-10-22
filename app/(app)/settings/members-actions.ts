'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { requireCaller } from '@/lib/caller';
import { cancelInvitation, changeRole, inviteMember, removeMember } from '@/lib/members';

// Settings › Members (lib/members.ts). Owners and admins; every action checks the caller itself (lib/members.ts too).

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    const data = await fn();
    revalidatePath('/settings');
    return { ok: true, data };
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('members action failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function inviteMemberAction(email: string, role: string): Promise<R<{ link: string | null; mailed: boolean }>> {
  return run(async () => inviteMember(await requireCaller('owner', 'admin'), String(email ?? ''), String(role ?? 'member')));
}

export async function cancelInvitationAction(id: string): Promise<R<null>> {
  return run(async () => {
    await cancelInvitation(await requireCaller('owner', 'admin'), String(id ?? ''));
    return null;
  });
}

export async function changeRoleAction(userId: string, role: string): Promise<R<null>> {
  return run(async () => {
    await changeRole(await requireCaller('owner', 'admin'), String(userId ?? ''), String(role ?? ''));
    return null;
  });
}

export async function removeMemberAction(userId: string): Promise<R<{ computers: number; keys: number; claims: number; unassigned: number }>> {
  return run(async () => removeMember(await requireCaller('owner', 'admin'), String(userId ?? '')));
}
