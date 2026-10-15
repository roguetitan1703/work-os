'use server';

import { revalidatePath } from 'next/cache';
import { setBlockedIds } from '@/lib/discord/client';

export async function saveBlockedChannels(ids: string[]): Promise<void> {
  await setBlockedIds(ids);
  revalidatePath('/settings');
}
