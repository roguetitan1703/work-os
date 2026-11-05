// Who may be assigned to a task, and the assignee picker options (task page on desktop and phone). No server imports:
// used by client components too.
import { readable, type Readable } from './visibility';

/**
 * The one assignee rule (docs/multi-user.md "Assignee"): someone who can see the task. Any member on a task shared with
 * everyone, the people on the list of a project shared with chosen people, only the owner on a private task.
 * (Membership of the organization is checked where the input is resolved.)
 */
export const canBeAssigned = (task: Readable, userId: string | null | undefined): boolean => readable(task, userId);

/**
 * The query form, for moving many tasks at once to a placement: those whose assignee could not see them there (to
 * unassign). null when everyone can (shared with the organization).
 */
export function unassignableFilter(place: { ownerId: string; visibility: string; sharedWith?: string[] }): Record<string, unknown> | null {
  if (place.visibility === 'org') return null;
  const may = place.visibility === 'members' ? [place.ownerId, ...(place.sharedWith ?? [])] : [place.ownerId];
  return { assigneeId: { $nin: [null, ...may] } };
}

/** Members to assign, you first; an assignee who has left the organization stays listed so the select shows them. */
export function assigneeOptions(people: Record<string, string>, me: string, current: string | null, task?: Readable): { id: string; name: string }[] {
  const others = Object.entries(people)
    .filter(([id]) => id !== me && (!task || canBeAssigned(task, id)))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [...(me && (!task || canBeAssigned(task, me)) ? [{ id: me, name: 'Me' }] : []), ...others];
  if (current && !out.some(o => o.id === current)) out.push({ id: current, name: Object.hasOwn(people, current) ? people[current] : 'A former member' });
  return out;
}
