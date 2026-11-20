import 'server-only';
import { excerpt, matchesAll, tierOf, wordRegex, wordsFilter, type Hit, type KindResult } from './match';
import { join, ms, READ, result, type Ctx } from './context';

type ProjectRow = { _id: string; name: string; client?: string; description?: string; status: string; ownerId: string; updatedAt: Date };
type Line = { id?: string; text: string; archivedAt?: Date };
type StateRow = { _id: string; projectId: string; ownerId: string; updatedAt: Date; now?: { text: string } | null; next?: Line[]; later?: Line[]; decisions?: Line[] };

/**
 * Projects: name, client and description; and each line of their State (Now, Next, Later, Decisions), which opens the
 * project at that line. Both read through the door; a State is placed like its project.
 */
export async function searchProjects(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (!words.length) return { hits: [], count: 0 };
  // Every word in one line (not spread over several).
  const line = { $elemMatch: { $and: words.map(w => ({ text: wordRegex(w) })) } };
  const now = { $and: words.map(w => ({ 'now.text': wordRegex(w) })) };
  const [projects, states] = (await Promise.all([
    c.projects.find(wordsFilter(['name', 'client', 'description'], words), { projection: { name: 1, client: 1, description: 1, status: 1, ownerId: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(READ).toArray(),
    c.states
      .find(
        { $or: [now, { next: line }, { later: line }, { decisions: line }] },
        { projection: { projectId: 1, ownerId: 1, updatedAt: 1, 'now.text': 1, 'next.id': 1, 'next.text': 1, 'later.id': 1, 'later.text': 1, 'decisions.id': 1, 'decisions.text': 1, 'decisions.archivedAt': 1 } },
      )
      .limit(READ)
      .toArray(),
  ])) as [ProjectRow[], StateRow[]];

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
    const push = (part: 'Now' | 'Next' | 'Later' | 'Decision', l: Line, hash: string) => {
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
        open: openStatus(proj.status) && part !== 'Decision',
        mine: st.ownerId === s.userId,
        at: ms(st.updatedAt),
      });
    };
    if (st.now?.text) push('Now', st.now, 'state-now');
    for (const l of st.next ?? []) push('Next', l, `state-next-${l.id}`);
    for (const l of st.later ?? []) push('Later', l, `state-later-${l.id}`);
    for (const l of st.decisions ?? []) if (!l.archivedAt) push('Decision', l, 'state-decisions');
  }
  return result(ctx, hits, Math.max(projects.length, states.length));
}
