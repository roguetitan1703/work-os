'use server';

import { revalidatePath } from 'next/cache';
import { asCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import { setOrders, undoOrders, type OrdersLayer } from '@/lib/data/orders';

// Marking a page as Orders (standing rules every AI reads first): a person in the app only, and only as far as their role
// goes (lib/data/orders.ts setOrders): an owner of the organization for the organization layer, the project's owner for
// the project layer, anyone for their own pages. There is no MCP tool for this. The text of an Orders page keeps a version per
// change (lib/data/orders.ts); the note page reads them (ordersHistory) and the person who holds the layer undoes one here.

export async function setOrdersAction(noteId: string, layer: OrdersLayer | null, updatedAt?: number): Promise<{ ok: true } | { error: string }> {
  try {
    if (layer !== null && layer !== 'org' && layer !== 'project' && layer !== 'person') return { error: 'Unknown layer' };
    await asCaller(c => setOrders(c, String(noteId).slice(0, 60), layer, userActor(c.userId), typeof updatedAt === 'number' ? updatedAt : undefined));
    revalidatePath(`/notes/${noteId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not change that' };
  }
}

/** Writes the text before version `v` back as a new version. Holder only; `updatedAt` is the page as the person last saw it. */
export async function undoOrdersAction(noteId: string, v: number, updatedAt?: number): Promise<{ ok: true; version: number } | { error: string }> {
  try {
    if (!Number.isInteger(v) || v < 2 || v > 1_000_000) return { error: 'Unknown version' };
    const r = await asCaller(c => undoOrders(c, String(noteId).slice(0, 60), v, userActor(c.userId), typeof updatedAt === 'number' ? updatedAt : undefined));
    revalidatePath(`/notes/${noteId}`);
    return { ok: true, version: r.version };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not undo that' };
  }
}
