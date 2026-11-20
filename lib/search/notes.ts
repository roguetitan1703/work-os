import 'server-only';
import { SHELVES, shelfLabel, shelfOf, type Shelf } from '../notes-shelves';
import { excerpt, fold, matchesAll, tierOf, wordRegex, type Hit, type KindResult } from './match';
import { join, ms, projectName, READ, recentMatching, result, titleFilter, type Ctx } from './context';

type Row = { _id: string; title?: string; body?: string; projectId: string | null; taskId: string | null; parentId?: string | null; shelf?: Shelf; handover?: unknown; orders?: unknown; archived: boolean; ownerId: string; updatedAt: Date };

const PROJ = { title: 1, body: 1, projectId: 1, taskId: 1, parentId: 1, shelf: 1, handover: 1, orders: 1, archived: 1, ownerId: 1, updatedAt: 1 } as const;

/** Notes: title, text (the hit shows the part with the words) and shelf. Deleted notes never. */
export async function searchNotes(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (!words.length) return { hits: [], count: 0 };
  // A word may name a shelf ("runbooks deploy").
  const filter = {
    $and: words.map(w => {
      const shelves = SHELVES.filter(x => fold(x.label).startsWith(w)).map(x => x.id);
      return { $or: [{ title: wordRegex(w) }, { body: wordRegex(w) }, ...(shelves.length ? [{ shelf: { $in: shelves } }] : [])] };
    }),
  };
  // Titles over every note first (an index); the text and shelf only of the most recently changed notes, and only
  // when the titles do not already fill the group.
  const titled = (await c.notes.find({ deletedAt: null, ...titleFilter(words) }, { projection: PROJ, hint: 'org_title' }).limit(READ).toArray()) as Row[];
  const early = titled.length >= ctx.take;
  const recent = early ? [] : ((await recentMatching(c.notes, 'updatedAt', { deletedAt: null }, filter, PROJ)) as unknown as Row[]);
  const seen = new Set<string>();
  const rows = [...titled, ...recent].filter(n => !seen.has(n._id) && !!seen.add(n._id));
  const hits: Hit[] = [];
  for (const n of rows) {
    const shelf = shelfOf(n);
    const title = n.title || 'Untitled';
    if (!matchesAll([title, n.body, shelf ? shelfLabel(shelf) : null], words)) continue;
    hits.push({
      kind: 'notes',
      id: n._id,
      title,
      meta: join(shelf ? shelfLabel(shelf) : n.taskId ? 'Task note' : null),
      snippet: excerpt(n.body ?? '', words),
      right: join(projectName(ctx, n.projectId), n.archived && 'Archived'),
      href: `/notes/${n._id}`,
      tier: tierOf(title, query),
      open: !n.archived,
      mine: n.ownerId === s.userId,
      at: ms(n.updatedAt),
    });
  }
  return result(ctx, hits, Math.max(titled.length, recent.length), early);
}
