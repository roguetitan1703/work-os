'use server';

import { revalidatePath } from 'next/cache';
import { readFeedToken, removeFeed, setFeed } from '@/lib/calendar-feed';
import { requireCaller } from '@/lib/caller';
import { baseUrl } from './base-url';

// Settings › Connections › Calendar (docs/calendar.md). A signed-in person (session, never an API key) makes, replaces or
// turns off their own calendar link. The link is kept sealed and read back only by its owner.

type R = { ok: true; url: string | null } | { ok: false; error: string };

async function make(): Promise<R> {
  try {
    const c = await requireCaller();
    const token = await setFeed(c);
    revalidatePath('/settings');
    return { ok: true, url: `${await baseUrl()}/api/calendar/${token}.ics` };
  } catch (e) {
    console.error('calendar link failed', e);
    return { ok: false, error: 'Could not make the link. Try again.' };
  }
}

/** Creates the link, or replaces it: the old one stops at once. */
export async function createCalendarLinkAction(): Promise<R> {
  return make();
}
export async function rotateCalendarLinkAction(): Promise<R> {
  return make();
}

/** The caller's own link again (Copy on another device). Only ever their own: it reads by the caller's id. */
export async function getCalendarLinkAction(): Promise<R> {
  try {
    const c = await requireCaller();
    const token = await readFeedToken(c);
    return { ok: true, url: token ? `${await baseUrl()}/api/calendar/${token}.ics` : null };
  } catch (e) {
    console.error('calendar link read failed', e);
    return { ok: false, error: 'Could not read the link. Try again.' };
  }
}

export async function revokeCalendarLinkAction(): Promise<R> {
  try {
    const c = await requireCaller();
    await removeFeed(c);
    revalidatePath('/settings');
    return { ok: true, url: null };
  } catch (e) {
    console.error('calendar revoke failed', e);
    return { ok: false, error: 'Could not turn the link off. Try again.' };
  }
}
