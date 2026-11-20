import 'server-only';
import { OPEN_STATUSES } from '../types';
import { excerpt, matchesAll, tierOf, wordsFilter, type Hit, type KindResult } from './match';
import { join, ms, projectName, READ, recentMatching, result, titleFilter, type Ctx } from './context';

const FIELDS = ['title', 'description', 'checklist.text', 'blockedReason', 'tags'];
const PROJ = { ref: 1, title: 1, status: 1, projectId: 1, archived: 1, updatedAt: 1, ownerId: 1, assigneeIds: 1, assigneeId: 1, description: 1, checklist: 1, blockedReason: 1, tags: 1 } as const;
type Row = { _id: string; ref: number; title: string; status: string; projectId: string | null; archived: boolean; updatedAt: Date; ownerId: string; assigneeIds?: string[]; assigneeId?: string | null; description?: string; checklist?: { text: string }[]; blockedReason?: string; tags?: string[] };

/**
 * Tasks, cheapest first: the number ("#12" only that; a plain "12" too) and the title over every task (indexes); when
 * that already fills the group, nothing else is read. Otherwise the description, checklist, blocked reason and tags
 * of the most recently changed tasks (RECENT), and the comments (lowest weight) of open tasks among the most recent
 * comments. A comment's task is read again through the door, so a comment never shows a task the caller cannot read.
 */
export async function searchTasks(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (query.needRef !== undefined) return { hits: [], count: 0 };
  const byRef = query.taskRef !== undefined ? c.tasks.find({ ref: query.taskRef }, { projection: PROJ }).limit(1).toArray() : Promise.resolve([]);
  const byTitle = words.length ? c.tasks.find(titleFilter(words), { projection: PROJ, hint: 'org_title' }).limit(READ).toArray() : Promise.resolve([]);
  const [refRows, titleRows] = (await Promise.all([byRef, byTitle])) as [Row[], Row[]];

  const seen = new Set<string>();
  const hits: Hit[] = [];
  const add = (t: Row, tier: Hit['tier'], snippet?: string) => {
    if (seen.has(t._id)) return;
    seen.add(t._id);
    const done = t.archived || t.status === 'Done' || t.status === 'Dropped';
    hits.push({
      kind: 'tasks',
      id: t._id,
      title: t.title,
      meta: join(`#${t.ref}`, snippet),
      right: join(projectName(ctx, t.projectId), t.archived ? 'Archived' : t.status),
      href: `/tasks/${t.ref}`,
      tier,
      open: !done,
      mine: t.ownerId === s.userId || !!t.assigneeIds?.includes(s.userId) || t.assigneeId === s.userId,
      at: ms(t.updatedAt),
    });
  };
  for (const t of refRows) add(t, 0);
  for (const t of titleRows) if (matchesAll([t.title], words)) add(t, tierOf(t.title, query));
  // Enough for the group: the other fields rank below every title match, so they could not change what shows.
  if (!words.length || hits.length >= ctx.take) return result(ctx, hits, titleRows.length, words.length > 0);

  const [textRows, comments] = (await Promise.all([
    recentMatching(c.tasks, 'updatedAt', {}, wordsFilter(FIELDS, words), PROJ),
    recentMatching(c.activity, 'at', { type: 'comment', taskId: { $type: 'string' } }, wordsFilter(['note'], words), { taskId: 1, note: 1 }),
  ])) as unknown as [Row[], { taskId: string; note?: string }[]];
  for (const t of textRows) {
    const other = [t.description, ...(t.checklist ?? []).map(i => i.text), t.blockedReason, ...(t.tags ?? [])];
    if (!matchesAll([t.title, ...other], words)) continue;
    const tier = tierOf(t.title, query);
    // When the title alone does not hold every word, show where the rest matched.
    const where = tier >= 3 ? other.find(x => x && matchesAll([t.title, x], words)) : undefined;
    add(t, tier, where ? excerpt(where, words, 90) : undefined);
  }
  // Comments: open tasks not found above, read through the door (it drops what the caller cannot read).
  const matched = comments.filter(a => a.note && matchesAll([a.note], words) && !seen.has(a.taskId));
  if (matched.length) {
    const ids = [...new Set(matched.map(a => a.taskId))].slice(0, READ);
    const rows = (await c.tasks.find({ _id: { $in: ids }, status: { $in: OPEN_STATUSES }, archived: { $ne: true } }, { projection: PROJ }).toArray()) as Row[];
    for (const t of rows) add(t, 5, excerpt(matched.find(a => a.taskId === t._id)?.note ?? '', words, 90));
  }
  return result(ctx, hits, Math.max(titleRows.length, textRows.length));
}
