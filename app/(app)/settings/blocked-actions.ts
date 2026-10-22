'use server';

import { revalidatePath } from 'next/cache';
import { orgGuildId, setBlockedIds } from '@/lib/discord/client';
import { asCaller, NotAllowed } from '@/lib/caller';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  // Which channels of the organization's Discord server Work OS may read: its owners and admins.
  await asCaller(async c => {
    if (!(await orgGuildId(c.orgId))) throw new NotAllowed('Your organization has no Discord server connected.');
    await setBlockedIds(c.orgId, ids);
  }, 'owner', 'admin');
  revalidatePath('/settings');
}
