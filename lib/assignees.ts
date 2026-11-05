// Assignees (docs/multi-user.md phase 4): a shared task can have several. No server imports: used by client components.
//
// Stored as `assigneeIds: string[]` on the task. Tasks written before that carry a single `assigneeId`; reads take
// either (assigneesOf), and queries match either (assignedTo, unassigned), until scripts/migrate-assignees.mjs has
// moved every task over. Every write of the list sets assigneeIds and removes the old field.

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

/** The update that stores a new list (and drops the old single field). */
export const setAssignees = (ids: string[]) => ({ $set: { assigneeIds: ids }, $unset: { assigneeId: '' } });

/** Initials for a compact row badge: "Bea Rao" → "BR", "bea" → "BE". */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}

/** Members to assign, you first; an assignee who has left the organization stays listed so the picker shows them. */
export function assigneeOptions(people: Record<string, string>, me: string, current: string[]): { id: string; name: string }[] {
  const others = Object.entries(people)
    .filter(([id]) => id !== me)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [...(me ? [{ id: me, name: 'Me' }] : []), ...others];
  for (const id of current) if (!out.some(o => o.id === id)) out.push({ id, name: 'A former member' });
  return out;
}
