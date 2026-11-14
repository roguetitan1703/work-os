import 'server-only';
import type { NoteDoc, ProjectDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { isPerson, type Actor } from '../actors';
import { InputError, NotFoundError } from './errors';

// Orders: standing rules served to every AI that starts work on a project (docs/flows/step-1.md section 2). Three layers,
// each a note carrying the `orders` field:
//   org      the organization's rules (the "Claude Code boilerplate" note, once its owner marks it): set by an owner of the
//            organization; the note must be shared with everyone, or the people it steers could not read it
//   project  a note of the project marked as its Orders: set by the project's owner
//   person   one of the person's own notes: set by its owner, served to that person's AIs only
// The flag is set in the app only (no MCP tool sets it), and a note that carries it is changed, moved to the trash or
// restored by a person in the app only, and only by the one who holds that layer (lib/data/notes.ts guardOrders): one
// prompt-injected agent, or one teammate, cannot rewrite the rules every agent follows.

export type OrdersLayer = 'org' | 'project' | 'person';
const MAX_TEXT = 20_000;

export type OrdersNote = { layer: OrdersLayer; noteId: string; title: string; text: string; truncated: boolean; createdBy: unknown; updatedBy: unknown; ownerId: string };

/** The Orders in force for a person starting work on a project: organization, project, person, in that order. */
export async function ordersFor(s: Scope, project: Pick<ProjectDoc, '_id'>): Promise<OrdersNote[]> {
  const c = await scoped(s);
  const live = { deletedAt: null, archived: false };
  const [org, proj, mine] = await Promise.all([
    c.notes.find({ orders: 'org', visibility: 'org', ...live }).sort({ createdAt: 1 }).limit(5).toArray(),
    c.notes.find({ orders: 'project', projectId: project._id, taskId: null, ...live }).sort({ createdAt: 1 }).limit(5).toArray(),
    c.notes.find({ orders: 'person', ownerId: s.userId, ...live }).sort({ createdAt: 1 }).limit(5).toArray(),
  ]);
  const out = (layer: OrdersLayer, list: NoteDoc[]): OrdersNote[] =>
    list.map(n => ({ layer, noteId: n._id, title: n.title, text: n.body.slice(0, MAX_TEXT), truncated: n.body.length > MAX_TEXT, createdBy: n.createdBy, updatedBy: n.updatedBy, ownerId: n.ownerId }));
  return [...out('org', org), ...out('project', proj), ...out('person', mine)];
}

/** May this person change a note that carries Orders? The one who holds the layer (see the top of this file). */
export async function canEditOrders(s: Scope, note: Pick<NoteDoc, 'orders' | 'ownerId' | 'projectId'>): Promise<boolean> {
  if (note.orders === 'person') return note.ownerId === s.userId;
  if (note.orders === 'project') {
    if (!note.projectId) return false;
    const p = await (await scoped(s)).projects.findOne({ _id: note.projectId }, { projection: { ownerId: 1 } });
    return p?.ownerId === s.userId;
  }
  if (note.orders === 'org') return (await (await import('../caller')).roleOf(s.userId, s.orgId)) === 'owner';
  return true;
}

/** Marks a note as a layer of Orders, or clears it (layer null). App only: the actor must be a person. */
export async function setOrders(s: Scope, noteId: string, layer: OrdersLayer | null, actor: Actor): Promise<{ noteId: string; orders: OrdersLayer | null }> {
  if (!isPerson(actor)) throw new InputError('Orders are set by a person in the app only.');
  const c = await scoped(s);
  const n = await c.notes.findOne({ _id: noteId, deletedAt: null });
  if (!n) throw new NotFoundError(`Note ${noteId} not found`);
  if (n.taskId || n.parentId) throw new InputError('Orders must be a top-level page: not a task note or a sub-page.');
  const want = layer ?? n.orders;
  if (want) {
    if (n.orders && n.orders !== want && layer) throw new InputError('This page is Orders already; clear it first.');
    const probe: Pick<NoteDoc, 'orders' | 'ownerId' | 'projectId'> = { orders: want, ownerId: n.ownerId, projectId: n.projectId };
    if (want === 'org') {
      if (!(await canEditOrders(s, probe))) throw new InputError('Only an owner of the organization can set the organization Orders.');
      if (layer && n.visibility !== 'org') throw new InputError('The organization Orders must be shared with everyone (a page in a shared project, or one that is not private).');
    } else if (want === 'project') {
      if (!n.projectId) throw new InputError('Project Orders must be a page of the project.');
      if (!(await canEditOrders(s, probe))) throw new InputError("Only the project's owner can set its Orders.");
    } else if (n.ownerId !== s.userId) throw new InputError('Your own Orders must be one of your own pages.');
  }
  await c.notes.updateOne({ _id: noteId }, layer ? { $set: { orders: layer } } : { $unset: { orders: '' } });
  return { noteId, orders: layer };
}
