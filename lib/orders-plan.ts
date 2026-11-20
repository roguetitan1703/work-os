// A project's own working plan in place of the organization's (Om, 21 Nov). Pure, so tests/orders-plan-check.mjs runs it.

export type PlanRow = { layer: 'org' | 'project' | 'person'; noteId: string; text: string; ordersBy?: string; createdBy: unknown; updatedBy: unknown; planFrom?: string };

const PLAN_HEADING = /^##\s+working plan\b.*$/im;

/** The "## Working plan" section of an Orders text (its heading to the next "## " heading or the end), or null. */
export function planSection(text: string): { start: number; end: number; section: string } | null {
  const m = PLAN_HEADING.exec(text);
  if (!m) return null;
  const after = m.index + m[0].length;
  const next = /^##\s/m.exec(text.slice(after));
  const end = next ? after + next.index : text.length;
  return { start: m.index, end, section: text.slice(m.index, end).trimEnd() };
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
    : o === proj ? (projText ? [{ ...o, text: projText }] : [])
    : [o]);
}
