'use server';

import { revalidatePath } from 'next/cache';
import { SafeError } from '@/lib/auth';
import { asCaller } from '@/lib/caller';
import { isOperator } from '@/lib/operator';
import { InputError } from '@/lib/data/errors';
import { DiscordError, setOrgGuildId } from '@/lib/discord/client';
import { hideDiscordCard, saveTimeSettings, unlinkDiscord } from '@/lib/profile';

// Each person's own settings (lib/profile.ts): timezone, quiet hours, their Discord link. Plus the organization's
// Discord server, which only the operator sets (one organization per server).

type R<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(what: string, fn: () => Promise<T>): Promise<R<T>> {
  try {
    const data = await fn();
    revalidatePath('/settings');
    return { ok: true, data };
  } catch (e) {
    if (e instanceof SafeError || e instanceof InputError || e instanceof DiscordError) return { ok: false, error: e.message };
    if ((e as { code?: number })?.code === 11000) return { ok: false, error: 'That Discord server already belongs to another organization.' };
    console.error(`${what} failed`, e instanceof Error ? e.name : e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function saveTimeSettingsAction(input: { timezone: string; quietStart: number; quietEnd: number; digestHour?: number }): Promise<R<null>> {
  return run('time settings', () => asCaller(async c => void (await saveTimeSettings(c, input))).then(() => null));
}

/** Hides the Connect Discord card on Today for this person (it stays in Settings › Notifications). */
export async function hideDiscordCardAction(): Promise<R<null>> {
  return run('discord card', () => asCaller(async c => hideDiscordCard(c)).then(() => null));
}

export async function unlinkDiscordAction(): Promise<R<null>> {
  return run('discord unlink', () => asCaller(async c => unlinkDiscord(c)).then(() => null));
}

/** The operator connects their current organization to a Discord server ('' disconnects). */
export async function saveDiscordServerAction(guildId: string): Promise<R<null>> {
  return run('discord server', () =>
    asCaller(async c => {
      if (!isOperator(c)) throw new SafeError('Only the operator of this Work OS can connect a Discord server.');
      await setOrgGuildId(c.orgId, guildId.trim() || null);
      return null;
    }),
  );
}
