'use server';

import { revalidatePath } from 'next/cache';
import { asCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import { setOrders, type OrdersLayer } from '@/lib/data/orders';

// Marking a page as Orders (standing rules every AI reads first): a person in the app only, and only as far as their role
// goes (lib/data/orders.ts setOrders): an owner of the organization for the organization layer, the project's owner for
// the project layer, anyone for their own pages. There is no MCP tool for this.

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
