import 'server-only';
import { excerpt, matchesAll, tierOf, wordRegex, wordsFilter, type Hit, type KindResult } from './match';
import { join, ms, READ, result, type Ctx } from './context';

type ProjectRow = { _id: string; name: string; client?: string; description?: string; status: string; ownerId: string; updatedAt: Date };
type Line = { id?: string; text: string; archivedAt?: Date };
type StateRow = { _id: string; projectId: string; ownerId: string; updatedAt: Date; now?: { text: string } | null; next?: Line[]; later?: Line[] };
type ListRow = { _id: string; projectId: string; id: string; text: string; ownerId: string; at: Date; parkedAt?: Date };

/**
 * Projects: name, client and description; and each line of their State (Now, Next, Later, Parked, Decisions), which opens the
 * project at that line. All read through the door; a State and its Parked and decision rows are placed like their project.
 */
export async function searchProjects(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (!words.length) return { hits: [], count: 0 };
  // Every word in one line (not spread over several).
  const line = { $elemMatch: { $and: words.map(w => ({ text: wordRegex(w) })) } };
  const now = { $and: words.map(w => ({ 'now.text': wordRegex(w) })) };
  const textOf = { $and: words.map(w => ({ text: wordRegex(w) })) };
  const [projects, states, decisions, parked] = (await Promise.all([
    c.projects.find(wordsFilter(['name', 'client', 'description'], words), { projection: { name: 1, client: 1, description: 1, status: 1, ownerId: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(READ).toArray(),
    c.states
      .find(
        { $or: [now, { next: line }, { later: line }] },
        { projection: { projectId: 1, ownerId: 1, updatedAt: 1, 'now.text': 1, 'next.id': 1, 'next.text': 1, 'later.id': 1, 'later.text': 1 } },
      )
      .limit(READ)
      .toArray(),
    c.stateDecisions.find({ archivedAt: null, ...textOf } as never, { projection: { projectId: 1, id: 1, text: 1, ownerId: 1, at: 1 } }).sort({ at: -1 }).limit(READ).toArray(),
    c.stateParked.find(textOf as never, { projection: { projectId: 1, id: 1, text: 1, ownerId: 1, at: 1, parkedAt: 1 } }).sort({ parkedAt: -1 }).limit(READ).toArray(),
  ])) as [ProjectRow[], StateRow[], ListRow[], ListRow[]];

  const hits: Hit[] = [];
  const openStatus = (st: string | undefined) => st === 'active' || st === 'paused';
  const statusWord = (st: string) => st.charAt(0).toUpperCase() + st.slice(1);
  for (const p of projects) {
    if (!matchesAll([p.name, p.client, p.description], words)) continue;
    const tier = tierOf(p.name, query);
    const desc = tier >= 3 && p.description && !matchesAll([p.name, p.client], words) ? excerpt(p.description, words, 90) : undefined;
    hits.push({ kind: 'projects', id: p._id, title: p.name, meta: join(p.client, desc), right: statusWord(p.status), href: `/projects/${encodeURIComponent(p._id)}`, tier, open: openStatus(p.status), mine: p.ownerId === s.userId, at: ms(p.updatedAt) });
  }
  for (const st of states) {
    const proj = ctx.projects.get(st.projectId);
    if (!proj) continue; // a State whose project the caller cannot read (should not happen: same placement)
    const base = `/projects/${encodeURIComponent(st.projectId)}`;
    const push = (part: 'Now' | 'Next' | 'Later', l: Line, hash: string) => {
      if (!matchesAll([l.text], words)) return;
      hits.push({
        kind: 'projects',
        id: `${st._id}:${part}:${l.id ?? 'now'}`,
        title: l.text.length > 140 ? l.text.slice(0, 140) + '…' : l.text,
        meta: part,
        right: proj.name,
        href: `${base}#${hash}`,
        // A State line ranks with the other fields: below a project whose name matches.
        tier: Math.max(tierOf(l.text, query), 2) as Hit['tier'],
        open: openStatus(proj.status),
        mine: st.ownerId === s.userId,
        at: ms(st.updatedAt),
      });
    };
    if (st.now?.text) push('Now', st.now, 'state-now');
    for (const l of st.next ?? []) push('Next', l, `state-next-${l.id}`);
    for (const l of st.later ?? []) push('Later', l, `state-later-${l.id}`);
  }
  // Decisions and Parked lines are rows of their own (lib/data/states.ts); a hit opens the project at that fold.
  const listHit = (part: 'Decision' | 'Parked', r: ListRow, hash: string) => {
    const proj = ctx.projects.get(r.projectId);
    if (!proj || !matchesAll([r.text], words)) return;
    hits.push({
      kind: 'projects',
      id: `${r.projectId}:${part}:${r.id}`,
      title: r.text.length > 140 ? r.text.slice(0, 140) + '…' : r.text,
      meta: part,
      right: proj.name,
      href: `/projects/${encodeURIComponent(r.projectId)}#${hash}`,
      tier: Math.max(tierOf(r.text, query), 2) as Hit['tier'],
      open: false,
      mine: r.ownerId === s.userId,
      at: ms(r.parkedAt ?? r.at),
    });
  };
  for (const r of decisions) listHit('Decision', r, 'state-decisions');
  for (const r of parked) listHit('Parked', r, 'state-parked');
  return result(ctx, hits, Math.max(projects.length, states.length, decisions.length, parked.length));
}
