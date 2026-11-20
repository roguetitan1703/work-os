import 'server-only';
import type { CodeLocation } from '../types';
import { matchesAll, tierOf, wordsFilter, type Hit, type KindResult } from './match';
import { join, ms, projectName, READ, result, type Ctx } from './context';

type FolderRow = { _id: string; name: string; remote?: string; branch?: string; projectId: string | null; seenAt: Date };
type ProjectRow = { _id: string; name: string; status: string; ownerId: string; updatedAt: Date; code?: CodeLocation[] };

const codeHref = (projectId: string) => `/projects/${encodeURIComponent(projectId)}?tab=info#code`;

/**
 * Files and folders: the caller's own linked folders (name, repository, branch) and the projects' code locations
 * (repository, path). Both open the project's Code; a folder not linked to a project opens Claude › Set up.
 */
export async function searchFiles(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (!words.length) return { hits: [], count: 0 };
  const [folders, projects] = (await Promise.all([
    c.workerFolders.find({ missing: { $ne: true }, ...wordsFilter(['name', 'remote', 'branch'], words) }, { projection: { name: 1, remote: 1, branch: 1, projectId: 1, seenAt: 1 } }).limit(READ).toArray(),
    c.projects.find(wordsFilter(['code.remote', 'code.path', 'code.subdir'], words), { projection: { name: 1, status: 1, ownerId: 1, updatedAt: 1, code: 1 } }).limit(READ).toArray(),
  ])) as [FolderRow[], ProjectRow[]];
  const hits: Hit[] = [];
  for (const f of folders) {
    if (!matchesAll([f.name, f.remote, f.branch], words)) continue;
    // Linked to a project the caller can no longer read: shown as unlinked.
    const project = f.projectId && ctx.projects.has(f.projectId) ? f.projectId : null;
    hits.push({
      kind: 'files',
      id: f._id,
      title: f.name,
      meta: join('Folder', f.remote, f.branch),
      right: project ? projectName(ctx, project) : 'Not linked',
      href: project ? codeHref(project) : '/claude?tab=setup',
      tier: tierOf(f.name, query),
      open: !!project,
      mine: true,
      at: ms(f.seenAt),
    });
  }
  for (const p of projects) {
    (p.code ?? []).forEach((l, i) => {
      if (!l.remote && l.by && l.by !== s.userId) return; // another person's folder link: theirs to find
      const where = [l.remote, l.subdir].filter(Boolean).join('/') || l.path || '';
      if (!where || !matchesAll([l.remote, l.path, l.subdir], words)) return;
      hits.push({
        kind: 'files',
        id: `${p._id}:code:${i}`,
        title: where,
        meta: join(l.remote ? 'Repository' : 'Folder', l.branch),
        right: p.name,
        href: codeHref(p._id),
        tier: tierOf(where.split(/[\\/]/).pop() ?? where, query),
        open: p.status === 'active' || p.status === 'paused',
        mine: p.ownerId === s.userId,
        at: ms(p.updatedAt),
      });
    });
  }
  return result(ctx, hits, Math.max(folders.length, projects.length));
}
