'use server';

import { revalidatePath } from 'next/cache';
import { setBlockedIds } from '@/lib/discord/client';
import { asCaller, NotAllowed } from '@/lib/caller';
import { discordScope } from '@/lib/people';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  // Which Discord channels Work OS may read: owners and admins of the organization the bot is linked to.
  await asCaller(async c => {
    const linked = await discordScope();
    if (!linked || linked.orgId !== c.orgId) throw new NotAllowed('Discord is linked to another organization.');
    await setBlockedIds(c.orgId, ids);
  }, 'owner', 'admin');
  revalidatePath('/settings');
}
