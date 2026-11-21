// A project's own working plan in place of the organization's (Om, 21 Nov). Pure, so tests/orders-plan-check.mjs runs it.

export type PlanRow = { layer: 'org' | 'project' | 'person'; noteId: string; text: string; ordersBy?: string; createdBy: unknown; updatedBy: unknown; planFrom?: string };

/**
 * The "## Working plan" section of an Orders text (its heading to the next "#" or "##" heading, or the end), or null. Lines
 * inside ``` fences are never headings.
 */
export function planSection(text: string): { start: number; end: number; section: string } | null {
  let start = -1, end = text.length, fenced = false, pos = 0;
  for (const line of text.split('\n')) {
    const at = pos;
    pos += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (start < 0 && /^##\s+working plan\b/i.test(line)) { start = at; continue; }
    if (start >= 0 && /^#{1,2}\s/.test(line)) { end = at; break; }
  }
  if (start < 0) return null;
  return { start, end, section: text.slice(start, end).trimEnd() };
}

/**
 * When the project Orders hold a "## Working plan" section, the org text is served with its own "## Working plan" section
 * swapped for the project's, and the project text without it, so an agent sees one plan. Only when the reader holds that
 * project layer and wrote its text (their agents included): project rules someone else wrote stay information
 * (ordersWrittenBy in lib/data/orders.ts) and are never swapped into the organization's rules.
 */
export function withProjectPlan<T extends PlanRow>(list: T[], reader: string): T[] {
  const mine = (a: unknown) => (a as { userId?: string } | null)?.userId === reader;
  const proj = list.find(o => o.layer === 'project' && o.ordersBy === reader && mine(o.createdBy) && mine(o.updatedBy) && planSection(o.text));
  const org = list.find(o => o.layer === 'org');
  const orgPlan = org && planSection(org.text);
  if (!proj || !org || !orgPlan) return list;
  const projPlan = planSection(proj.text)!;
  const orgText = `${org.text.slice(0, orgPlan.start)}${projPlan.section}\n\n${org.text.slice(orgPlan.end).trimStart()}`.trimEnd();
  const projText = `${proj.text.slice(0, projPlan.start)}${proj.text.slice(projPlan.end).trimStart()}`.trim();
  return list.flatMap(o =>
    o === org ? [{ ...o, text: orgText, planFrom: proj.noteId }]
    : o === proj ? [{ ...o, text: projText || 'This project\'s Working plan is shown in the organization Orders above.' }]
    : [o]);
}
