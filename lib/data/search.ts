import 'server-only';
import { scoped, type Scope } from '../scope';

export type SearchHit = {
  kind: 'task' | 'project' | 'note' | 'claude';
  id: string;
  title: string;
  /** Second line: ref, status, project, a note excerpt. */
  meta: string;
  href: string;
};
export type SearchResult = { q: string; tasks: SearchHit[]; projects: SearchHit[]; notes: SearchHit[]; claude: SearchHit[] };

const PER_GROUP = 6;
export const MAX_QUERY = 80;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A short piece of `body` around the first match of `re`. */
function excerpt(body: string, re: RegExp): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const m = re.exec(flat);
  if (!m) return flat.slice(0, 80);
  const from = Math.max(0, m.index - 30);
  return (from > 0 ? '…' : '') + flat.slice(from, from + 90) + (flat.length > from + 90 ? '…' : '');
}

/**
 * Search tasks (title, #ref), projects (name, client), notes (title, text) and Claude items (title, C-ref).
 * The text is escaped, so it is always a plain substring match. At most PER_GROUP hits per group.
 */
export async function searchAll(s: Scope, raw: string): Promise<SearchResult> {
  const q = raw.trim().slice(0, MAX_QUERY);
  const empty: SearchResult = { q, tasks: [], projects: [], notes: [], claude: [] };
  if (!q) return empty;
  const c = await scoped(s);
  const re = new RegExp(escapeRegex(q.replace(/^#/, '')), 'i');
  const taskRef = /^#?(\d{1,9})$/.exec(q);
  const claudeRef = /^c(\d{1,9})$/i.exec(q) ?? (/^#?(\d{1,9})$/.exec(q));

  const [tasks, projects, notes, items, allProjects] = await Promise.all([
    c.tasks
      .find({ $or: [{ title: re }, ...(taskRef ? [{ ref: Number(taskRef[1]) }] : [])] }, { projection: { ref: 1, title: 1, status: 1, projectId: 1, archived: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .limit(40)
      .toArray(),
    c.projects.find({ $or: [{ name: re }, { client: re }] }, { projection: { name: 1, client: 1, status: 1 } }).sort({ updatedAt: -1 }).limit(PER_GROUP).toArray(),
    c.notes.find({ deletedAt: null, $or: [{ title: re }, { body: re }] }, { projection: { title: 1, body: 1, projectId: 1, taskId: 1, archived: 1 } }).sort({ updatedAt: -1 }).limit(PER_GROUP).toArray(),
    c.claudeItems
      .find({ $or: [{ title: re }, ...(claudeRef ? [{ ref: Number(claudeRef[1]) }] : [])] }, { projection: { ref: 1, title: 1, state: 1, projectId: 1 } })
      .sort({ updatedAt: -1 })
      .limit(PER_GROUP)
      .toArray(),
    c.projects.find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const names = new Map(allProjects.map(p => [p._id, p.name]));
  const exactRef = taskRef ? Number(taskRef[1]) : -1;
  // An exact #ref first, then open before finished.
  const ranked = [...tasks].sort((a, b) => Number(b.ref === exactRef) - Number(a.ref === exactRef) || Number(a.archived) - Number(b.archived) || Number(['Done', 'Dropped'].includes(a.status)) - Number(['Done', 'Dropped'].includes(b.status)));

  return {
    q,
    tasks: ranked.slice(0, PER_GROUP).map(t => ({
      kind: 'task' as const,
      id: t._id,
      title: t.title,
      meta: [`#${t.ref}`, t.archived ? 'Archived' : t.status, t.projectId ? names.get(t.projectId) : null].filter(Boolean).join(' · '),
      href: `/tasks/${t.ref}`,
    })),
    projects: projects.map(p => ({ kind: 'project' as const, id: p._id, title: p.name, meta: [p.client, p.status].filter(Boolean).join(' · '), href: `/projects/${p._id}` })),
    notes: notes.map(n => ({
      kind: 'note' as const,
      id: n._id,
      title: n.title || 'Untitled',
      meta: [n.projectId ? names.get(n.projectId) : null, excerpt(n.body ?? '', re)].filter(Boolean).join(' · '),
      href: `/notes/${n._id}`,
    })),
    claude: items.map(i => ({
      kind: 'claude' as const,
      id: i._id,
      title: i.title,
      meta: [`C${i.ref}`, i.state, names.get(i.projectId)].filter(Boolean).join(' · '),
      href: `/projects/${i.projectId}?tab=claude&claude=C${i.ref}`,
    })),
  };
}
