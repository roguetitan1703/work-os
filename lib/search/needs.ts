import 'server-only';
import type { NeedDoc } from '../db';
import { answerVisible, answerVisibleFilter } from '../data/needs';
import { excerpt, matchesAll, tierOf, wordRegex, type Hit, type KindResult } from './match';
import { join, ms, projectName, READ, result, type Ctx } from './context';

type Row = Pick<NeedDoc, '_id' | 'ref' | 'projectId' | 'taskRef' | 'to' | 'kind' | 'ask' | 'options' | 'status' | 'answer' | 'createdAt' | 'ownerId' | 'appOnly' | 'from'>;
const FIELDS = ['ask', 'example', 'options.label', 'options.means'];
const KIND: Record<NeedDoc['kind'], string> = { decide: 'Decide', approve: 'Approve', review: 'Review', do: 'Do', chase: 'Chase' };

/**
 * Needs: "N3", the question, its options and the answer. Open first. An app-only Need's answer is searched only for
 * the people who may read it (lib/data/needs.ts forViewer): for anyone else it is in neither the query, the match nor the hit.
 */
export async function searchNeeds(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (query.taskRef !== undefined && query.refOnly) return { hits: [], count: 0 };
  const answer = answerVisibleFilter(s.userId);
  const filter =
    query.needRef !== undefined
      ? { ref: query.needRef }
      : words.length
        ? { $and: words.map(w => ({ $or: [...FIELDS.map(f => ({ [f]: wordRegex(w) })), { $and: [{ 'answer.text': wordRegex(w) }, answer] }] })) }
        : null;
  if (!filter) return { hits: [], count: 0 };
  const rows = (await c.needs
    .find(filter, { projection: { ref: 1, projectId: 1, taskRef: 1, to: 1, kind: 1, ask: 1, options: 1, status: 1, answer: 1, createdAt: 1, ownerId: 1, example: 1, appOnly: 1, from: 1 } })
    .sort({ createdAt: -1 })
    .limit(READ)
    .toArray()) as (Row & { example?: string })[];
  const hits: Hit[] = [];
  for (const n of rows) {
    const opts = (n.options ?? []).flatMap(o => [o.label, o.means]);
    const answerText = answerVisible(n, s.userId) ? n.answer?.text : undefined;
    const exact = query.needRef !== undefined;
    if (!exact && !matchesAll([n.ask, n.example, ...opts, answerText], words)) continue;
    const open = n.status === 'open';
    const tier = exact ? 0 : tierOf(n.ask, query);
    const where = !exact && tier >= 3 ? [...opts, answerText].find(x => x && matchesAll([n.ask, x], words)) : undefined;
    const title = n.ask.length > 160 ? n.ask.slice(0, 160) + '…' : n.ask;
    hits.push({
      kind: 'needs',
      id: n._id,
      title,
      meta: join(`N${n.ref}`, KIND[n.kind], n.taskRef ? `#${n.taskRef}` : null, where && excerpt(where, words, 80)),
      right: join(projectName(ctx, n.projectId), open ? 'Open' : n.status === 'answered' ? 'Answered' : 'Closed'),
      // Open and asked of the caller: the Needs page; else the project's Needs tab. Both scroll to it (#need-N).
      href: open && n.to === s.userId ? `/needs#need-${n.ref}` : `/projects/${encodeURIComponent(n.projectId)}?tab=needs#need-${n.ref}`,
      tier,
      open,
      mine: n.to === s.userId || n.ownerId === s.userId,
      at: ms(n.createdAt),
    });
  }
  return result(ctx, hits, rows.length);
}
