'use server';

import { revalidatePath } from 'next/cache';
import { setBlockedIds } from '@/lib/discord/client';
import { asCaller } from '@/lib/caller';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  // Which Discord channels Work OS may read: owners and admins only.
  await asCaller(() => setBlockedIds(ids), 'owner', 'admin');
  revalidatePath('/settings');
}
