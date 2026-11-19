// Where an open Claude item goes when the items retire (H11 step 7; plan decision 11, docs/flows/agent-system.md 16.7).
// Pure: no imports, so scripts/migrate-claude-items.mjs and tests/claude-items-migrate-check.mjs load it with type stripping.
//
//   open item (queued, active, blocked) waiting on a person  -> a Later line "title: first sentence", waiting on that person
//   open item, kind not idea, with a done-when              -> a task: P3, tag from-claude-item, description = why + "Done when: ..."
//   open idea, or an open item without a done-when           -> a Later line "title: first sentence of why" (waits on its waitingText)
//   done and dropped items                                   -> stay as they are (history); no plan

export type MigrateItem = { ref: number; title: string; why: string; doneWhen?: string; kind: string; waitingText?: string; waitingOn?: string | null; state: string };

export type MigratePlan =
  | { to: 'task'; title: string; description: string; priority: 'P3'; tags: string[] }
  | { to: 'later'; text: string; waitsOn?: string };

export const OPEN_STATES = ['queued', 'active', 'blocked'];
const LINE = 500; // lib/data/states.ts LIMITS.line
const WAITS = 200;
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** The movedTo of a task: "#12"; of a Later line: "later:l_ab12cd34". */
export const movedToTask = (ref: number) => `#${ref}`;
export const movedToLine = (id: string) => `later:${id}`;

export function migratePlan(i: MigrateItem, personName?: string): MigratePlan | null {
  if (!OPEN_STATES.includes(i.state)) return null;
  const why = (i.why ?? '').trim();
  const first = (why.split(/(?<=[.!?])\s/)[0] ?? '').trim() || why;
  const later = (waits?: string): MigratePlan => ({ to: 'later', text: clip(first ? `${i.title}: ${first}` : i.title, LINE), ...(waits ? { waitsOn: clip(waits, WAITS) } : {}) });
  if (i.waitingOn) {
    const who = personName || 'a person';
    return later(`${who}${i.waitingText?.trim() ? `: ${i.waitingText.trim()}` : ''}`);
  }
  if (i.kind !== 'idea' && i.doneWhen?.trim()) {
    return { to: 'task', title: clip(i.title, 300), description: clip([why, `Done when: ${i.doneWhen.trim()}`].filter(Boolean).join('\n\n'), 20_000), priority: 'P3', tags: ['from-claude-item'] };
  }
  return later(i.waitingText?.trim() || undefined);
}
