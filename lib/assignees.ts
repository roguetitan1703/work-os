// Assignee picker options (task page on desktop and phone). No server imports: used by client components.

/** Members to assign, you first; an assignee who has left the organization stays listed so the select shows them. */
export function assigneeOptions(people: Record<string, string>, me: string, current: string | null): { id: string; name: string }[] {
  const others = Object.entries(people)
    .filter(([id]) => id !== me)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [...(me ? [{ id: me, name: 'Me' }] : []), ...others];
  if (current && !out.some(o => o.id === current)) out.push({ id: current, name: 'A former member' });
  return out;
}
