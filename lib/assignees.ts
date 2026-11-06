// Assignees (docs/multi-user.md "Assignee"): who may be assigned to a task (a shared task can have several), and the
// picker options (task page on desktop and phone). No server imports: used by client components too.
//
// Stored as `assigneeIds: string[]` on the task. Tasks written before that carry a single `assigneeId`; reads take
// either (assigneesOf), and queries match either (assignedTo, unassigned, unassignableFilter), until
// scripts/migrate-assignees.mjs has moved every task over. Every write of the list sets assigneeIds and removes the old
// field.
import { readable, type Readable } from './visibility';

/** Most people on one task. */
export const MAX_ASSIGNEES = 20;

/** A task document's assignees, old single field included. */
export function assigneesOf(d: { assigneeIds?: string[] | null; assigneeId?: string | null }): string[] {
  if (Array.isArray(d.assigneeIds)) return d.assigneeIds;
  return d.assigneeId ? [d.assigneeId] : [];
}

/** Query: tasks this person is one of the assignees of. */
export const assignedTo = (userId: string) => ({ $or: [{ assigneeIds: userId }, { assigneeId: userId }] });

/** Query: tasks with no assignee at all. */
export const unassigned = () => ({ assigneeIds: { $in: [null, []] }, assigneeId: null });

/**
 * The one assignee rule: someone who can see the task. Any member on a task shared with everyone, the people on the
 * list of a project shared with chosen people, only the owner on a private task. Every assignee of a task must pass it.
 * (Membership of the organization is checked where the input is resolved.)
 */
export const canBeAssigned = (task: Readable, userId: string | null | undefined): boolean => readable(task, userId);

type Place = { ownerId: string; visibility: string; sharedWith?: string[] };

/** Who may be assigned at a placement, or null for everyone (shared with the organization). */
function mayBeAssigned(place: Place): string[] | null {
  if (place.visibility === 'org') return null;
  return place.visibility === 'members' ? [place.ownerId, ...(place.sharedWith ?? [])] : [place.ownerId];
}

/**
 * The query form, for moving many tasks at once to a placement: those with any assignee who could not see them there
 * (old single field included). null when everyone can (shared with the organization). Pair it with unassignPull.
 */
export function unassignableFilter(place: Place): Record<string, unknown> | null {
  const may = mayBeAssigned(place);
  if (!may) return null;
  return { $or: [{ assigneeIds: { $elemMatch: { $nin: may } } }, { assigneeId: { $nin: [null, ...may] } }] };
}

/**
 * The update that takes everyone who could not see the task at the placement off its list, keeping the others. The door
 * allows no update pipelines, so a task still on the old single field is moved to the list first (assigneesOf).
 */
export function unassignPull(place: Place): { $pull: { assigneeIds: { $nin: string[] } } } {
  return { $pull: { assigneeIds: { $nin: mayBeAssigned(place) ?? [] } } };
}

/** Members to assign, you first, only those who can see the task; an assignee who has left stays listed so the picker shows them. */
export function assigneeOptions(people: Record<string, string>, me: string, current: string[], task?: Readable): { id: string; name: string }[] {
  const others = Object.entries(people)
    .filter(([id]) => id !== me && (!task || canBeAssigned(task, id)))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [...(me && (!task || canBeAssigned(task, me)) ? [{ id: me, name: 'Me' }] : []), ...others];
  for (const id of current) if (!out.some(o => o.id === id)) out.push({ id, name: Object.hasOwn(people, id) ? people[id] : 'A former member' });
  return out;
}

/** Initials for a compact row badge: "Bea Rao" gives "BR", "bea" gives "BE". */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}
