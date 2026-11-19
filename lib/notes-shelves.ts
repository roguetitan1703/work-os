// Notes on shelves (docs/flows/agent-system.md section 3) and the shared default title. Client-safe: no imports.

/** The title a new page has until someone names it; pages with it are never refused as duplicates. */
export const UNTITLED = 'Untitled';

export type Shelf = 'overview' | 'designs' | 'runbooks' | 'handovers';

/** A project's shelves in the order they show. Archive is not a shelf: it is the project's archived notes. */
export const SHELVES: { id: Shelf; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'What the project is and where it stands' },
  { id: 'designs', label: 'Designs', hint: 'Plans, designs and decisions' },
  { id: 'runbooks', label: 'Runbooks', hint: 'How to do a recurring job' },
  { id: 'handovers', label: 'Handovers', hint: 'What a session left for the next one (end_work)' },
];

/** The filter value for archived project notes. */
export const ARCHIVE = 'archive';

export const shelfLabel = (s: Shelf): string => SHELVES.find(x => x.id === s)?.label ?? s;

/**
 * The shelf of a top-level project note; null for a task's note and for a sub-page (they sit with their task or page). A note
 * nobody moved sits where it belongs by what it is: a handover on Handovers, an Orders page on Overview, the rest on Designs.
 */
export function shelfOf(n: { shelf?: Shelf | null; handover?: unknown; orders?: unknown; taskId?: string | null; parentId?: string | null }): Shelf | null {
  if (n.taskId || n.parentId) return null;
  if (n.shelf) return n.shelf;
  return n.handover ? 'handovers' : n.orders ? 'overview' : 'designs';
}
