// What the project page shows of a project's production setting (H8). Pure: no database, so the page's client code can import it.

export type ProductionConfig = { remotes: string[]; branches: string[]; targets: string[] };
/** The effective setting: what is stored, else the default; `isDefault` when nothing is stored; `off` when this project has no block. */
export type ProductionView = ProductionConfig & { off: boolean; isDefault: boolean };

/** A line for the page and the feed: "master or main on owner/name". */
export function productionSummary(v: ProductionView): string {
  if (v.off) return 'none';
  const b = v.branches.length ? v.branches.join(' or ') : 'no branch';
  const r = v.remotes.length ? v.remotes.join(', ') : 'no repository';
  const t = v.targets.length ? `, commands on ${v.targets.join(', ')}` : '';
  return `${b} on ${r}${t}`;
}
