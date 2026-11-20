import 'server-only';
import { TOOLS } from '../mcp/docs';
import { matchesAll, tierOf, type Hit, type KindResult } from './match';
import { result, type Ctx } from './context';

/**
 * Claude's tools (Claude › Set up › What Claude can do here), found under Pages: name, title, what it does and the
 * example. Static, no database read; kept on the server so the tool texts are not sent to every page.
 */
export async function searchTools(ctx: Ctx): Promise<KindResult> {
  const { words } = ctx.query;
  if (!words.length) return { hits: [], count: 0 };
  const hits: Hit[] = [];
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!matchesAll([name, t.title, t.description, t.example], words)) continue;
    const tier = Math.min(tierOf(name, ctx.query), tierOf(t.title, ctx.query)) as Hit['tier'];
    hits.push({ kind: 'pages', id: `tool:${name}`, title: name, meta: `Claude tool · ${t.title}`, snippet: t.description.slice(0, 140), href: `/claude?tab=setup#tool-${name}`, tier, open: true, mine: false, at: 0 });
  }
  return result(ctx, hits, 0);
}
