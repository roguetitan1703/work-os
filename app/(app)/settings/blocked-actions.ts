'use server';

import { revalidatePath } from 'next/cache';
import { saveBlockedAs } from '@/lib/discord/client';
import { discordLinkOf } from '@/lib/profile';
import { asCaller, NotAllowed } from '@/lib/caller';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  // Which channels of the organization's Discord server Work OS may read: its owners and admins.
  await asCaller(async c => {
    const link = await discordLinkOf(c);
    if (!link) throw new NotAllowed('Your organization has no Discord server connected.');
    if (!link.discordId) throw new NotAllowed('Link your Discord account first.');
    // Only the channels this person can see are replaced; blocks on anything hidden from them stay.
    await saveBlockedAs(link, Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  }, 'owner', 'admin');
  revalidatePath('/settings');
}
