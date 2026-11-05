// The visibility rule (docs/multi-user.md "Private vs shared"), with no server imports so the pickers can use it too.
// A shared document (project, task, note, Claude item, history, trash) is read by everyone in its organization
// (visibility 'org'), by its owner, and, when its visibility is 'members', by the people in its sharedWith (a project's
// list, copied onto everything in the project; it always holds the project's owner). readable() and readableFilter()
// are the same rule in memory and as a query. The data door (lib/scope.ts) and everything that decides who may see,
// be assigned, be waited on or be told about a shared document are built on these two.

export type Readable = { ownerId?: string; visibility?: string; sharedWith?: unknown };

/** May userId read a shared document placed like d (same organization assumed)? */
export function readable(d: Readable | null | undefined, userId: string | null | undefined): boolean {
  if (!d || !userId) return false;
  return d.visibility === 'org' || d.ownerId === userId || (d.visibility === 'members' && Array.isArray(d.sharedWith) && d.sharedWith.includes(userId));
}

/** The query form of readable(): the shared documents userId may read. */
export function readableFilter(userId: string): Record<string, unknown> {
  return { $or: [{ visibility: 'org' }, { ownerId: userId }, { visibility: 'members', sharedWith: userId }] };
}
