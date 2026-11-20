import 'server-only';
import { scoped, type Scope } from '../scope';
import type { Ctx } from './context';
import { parseQuery, SERVER_KINDS, type Kind, type KindResult, type SearchResult } from './match';
import { searchFiles } from './files';
import { searchNeeds } from './needs';
import { searchNotes } from './notes';
import { searchProjects } from './projects';
import { searchSessions } from './sessions';
import { searchTasks } from './tasks';
import { searchTools } from './tools';

const PROVIDERS: Partial<Record<Kind, (ctx: Ctx) => Promise<KindResult>>> = {
  tasks: searchTasks,
  projects: searchProjects,
  notes: searchNotes,
  sessions: searchSessions,
  needs: searchNeeds,
  files: searchFiles,
  pages: searchTools,
};

/** Hits per kind in All (the groups show 5, the best match comes from these); with one kind chosen, up to 50. */
const TAKE_ALL = 6;
const TAKE_ONE = 50;

/**
 * One search over the kinds read on the server (tasks, projects and their State lines, notes, sessions, Needs, files
 * and folders, Claude's tools), every read through the caller's door (lib/scope.ts): a person never sees another
 * organization's work or a private project that is not theirs. Settings and the app's pages are matched in the browser (lib/search/static.ts).
 * With `kind`, only that kind, with more hits.
 */
export async function searchAll(s: Scope, raw: unknown, kind?: Kind): Promise<SearchResult> {
  const query = parseQuery(raw);
  const out: SearchResult = { q: query.q, kinds: {} };
  if (!query.q) return out;
  const kinds = kind ? (SERVER_KINDS.includes(kind) ? [kind] : []) : SERVER_KINDS;
  if (!kinds.length) return out;
  const c = await scoped(s);
  // The projects the caller can read: names for the hits, and the check that a State or folder's project is readable.
  const rows = kinds.some(k => k !== 'pages') ? ((await c.projects.find({}, { projection: { name: 1, status: 1 } }).toArray()) as { _id: string; name: string; status: string }[]) : [];
  const ctx: Ctx = { c, s, query, take: kind ? TAKE_ONE : TAKE_ALL, projects: new Map(rows.map(p => [p._id, { name: p.name, status: p.status }])) };
  const results = await Promise.all(kinds.map(k => PROVIDERS[k]!(ctx)));
  kinds.forEach((k, i) => (out.kinds[k] = results[i]));
  return out;
}
