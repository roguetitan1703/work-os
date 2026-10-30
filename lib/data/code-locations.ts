// Where a project's code lives, and which project a Claude Code session is working in.
// Pure functions (no DB, no server-only) so they can be tested on their own.
//
// A project has `code: CodeLocation[]`. A location is a git remote (normalised to a
// lowercase "owner/name", credentials never kept) optionally narrowed by a subdir and/or
// branch, or an absolute folder path. The most specific match wins:
//   remote + subdir + branch  >  remote + subdir | remote + branch  >  remote  >  longest path prefix
// A branch ending in * matches by prefix (wt/ana* covers wt/anasignin).

import { InputError } from './errors';

export type CodeLocation = { remote?: string; path?: string; subdir?: string; branch?: string; host?: string };
export type CodeQuery = { remote?: string; path?: string; subdir?: string; branch?: string };
export type CodeProject = { id: string; name: string; code?: CodeLocation[] };
export type CodeMatch = { project: CodeProject; score: number; location: CodeLocation; how: string };

export const MAX_CODE_LOCATIONS = 20;

/** Any git remote form → lowercase "owner/name", or null. https, ssh://, git@host:owner/name, .git, credentials all handled. */
export function normalizeRemote(input: string | null | undefined): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
  const USER = /^[^@/]*@/; // user[:password]@ (credentials are dropped here)
  let hadHost = SCHEME.test(s);
  s = s.replace(SCHEME, '');
  if (USER.test(s)) hadHost = true;
  s = s.replace(USER, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  // scp-style "host:owner/name" (no scheme or user): the part before ":" is the host.
  const scp = s.match(/^([^/:]+):(?!\/)(.*)$/);
  if (scp) {
    hadHost = true;
    s = scp[2];
  } else {
    // Strip a leading host only when we know one is there (scheme or user@), or when it looks like
    // a host (has a dot) and at least owner/name follow it. "my.org/repo" stays owner "my.org".
    const segs = s.split('/').filter(Boolean);
    if (segs.length >= 2 && (hadHost || (segs[0].includes('.') && segs.length >= 3))) s = segs.slice(1).join('/');
  }
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return null;
  return `${owner}/${name}`.toLowerCase();
}

const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/** The host a remote was written with, lowercase, when it is not github.com ("owner/name" alone means GitHub). Null when none or not a plain host. */
export function remoteHost(input: string | null | undefined): string | null {
  const s = (input ?? '').trim();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)/i) ?? s.match(/^(?:[^@/\s]*@)([^:/\s]+):/) ?? s.match(/^([^/:@\s]+\.[^/:@\s]+):(?!\/)/);
  const h = m?.[1]?.toLowerCase();
  return h && h !== 'github.com' && HOST.test(h) ? h : null;
}

/** What a PC is told to clone: "owner/name" (GitHub) or https://host/owner/name. Null when the location has no remote. */
export function cloneSpec(loc: Pick<CodeLocation, 'remote' | 'host'>): string | null {
  if (!loc.remote) return null;
  return loc.host && HOST.test(loc.host) && loc.host !== 'github.com' ? `https://${loc.host}/${loc.remote}` : loc.remote;
}

/** Folder path for comparison: forward slashes, no trailing slash, lowercase (Windows paths are case-insensitive). */
export function normalizePath(input: string | null | undefined): string | null {
  const s = (input ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  // Windows paths (D:/…, or WSL/Git Bash forms /mnt/d/…, /d/…) are case-insensitive.
  const windows = /^[a-z]:/i.test(s) || (input ?? '').includes('\\') || /^\/mnt\/[a-z](\/|$)/i.test(s) || /^\/[a-z](\/|$)/i.test(s);
  return windows ? s.toLowerCase() : s;
}

/** Path relative to the repo root: forward slashes, no leading ./ or slashes, lowercase. "" = the root. */
export function normalizeSubdir(input: string | null | undefined): string {
  return (input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

export function normalizeBranch(input: string | null | undefined): string {
  return (input ?? '').trim().replace(/^refs\/heads\//, '');
}

/** Validates and normalises locations for storage. Throws InputError on bad input. */
export function cleanCodeLocations(input: CodeLocation[] | null | undefined): CodeLocation[] {
  if (!input) return [];
  if (input.length > MAX_CODE_LOCATIONS) throw new InputError(`At most ${MAX_CODE_LOCATIONS} code locations per project`);
  const out: CodeLocation[] = [];
  const seen = new Set<string>();
  for (const l of input) {
    const loc: CodeLocation = {};
    if (l.remote?.trim()) {
      const r = normalizeRemote(l.remote);
      if (!r) throw new InputError('Invalid remote URL: use owner/name or the clone URL');
      loc.remote = r;
      const host = remoteHost(l.remote) ?? (l.host?.trim() && HOST.test(l.host.trim().toLowerCase()) && l.host.trim().toLowerCase() !== 'github.com' ? l.host.trim().toLowerCase() : null);
      if (host) loc.host = host;
    }
    if (l.path?.trim()) {
      const p = l.path.trim().replace(/[\\/]+$/, '');
      if (p.length > 300) throw new InputError('Path is too long');
      loc.path = p;
    }
    if (!loc.remote && !loc.path) throw new InputError('A code location needs a remote or a path');
    const sub = normalizeSubdir(l.subdir);
    if (sub) {
      if (sub.length > 200 || sub.split('/').includes('..')) throw new InputError(`Bad subdir "${l.subdir}"`);
      loc.subdir = sub;
    }
    const br = normalizeBranch(l.branch);
    if (br) {
      if (br.length > 200 || /\s/.test(br)) throw new InputError(`Bad branch "${l.branch}"`);
      loc.branch = br;
    }
    const k = JSON.stringify([loc.remote, loc.path && normalizePath(loc.path), loc.subdir, loc.branch, loc.host]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(loc);
    }
  }
  return out;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + '/');
}

/** Score of one location against a query; 0 = no match. */
function scoreLocation(loc: CodeLocation, q: { remote: string | null; path: string | null; subdir: string; branch: string }): { score: number; how: string } {
  let best = { score: 0, how: '' };
  if (loc.remote && q.remote && normalizeRemote(loc.remote) === q.remote) {
    const sub = normalizeSubdir(loc.subdir);
    const br = normalizeBranch(loc.branch);
    const subOk = !sub || (!!q.subdir && within(q.subdir, sub));
    // A trailing * matches a branch prefix, e.g. `wt/ana*` covers wt/anasignin.
    const brOk = !br || (br.endsWith('*') ? q.branch.startsWith(br.slice(0, -1)) : br === q.branch);
    if (subOk && brOk) {
      // Tiers: 100 remote, 120 remote+subdir or +branch, 140 all three. Deeper subdirs win ties.
      const score = 100 + (sub ? 20 : 0) + (br ? 20 : 0) + (sub ? Math.min(sub.split('/').length, 9) / 10 : 0);
      best = { score, how: ['remote', sub && 'subdir', br && 'branch'].filter(Boolean).join(' + ') };
    }
  }
  if (loc.path && q.path) {
    const lp = normalizePath(loc.path);
    if (lp && within(q.path, lp)) {
      const score = 1 + Math.min(lp.length, 999) / 1000; // always below any remote match; longer prefix wins
      if (score > best.score) best = { score, how: 'path' };
    }
  }
  return best;
}

/** The project whose code location best matches, or null. */
export function matchCodeLocation(projects: CodeProject[], query: CodeQuery): CodeMatch | null {
  const q = {
    remote: normalizeRemote(query.remote),
    path: normalizePath(query.path),
    subdir: normalizeSubdir(query.subdir),
    branch: normalizeBranch(query.branch),
  };
  if (!q.remote && !q.path) return null;
  let best: CodeMatch | null = null;
  for (const p of projects) {
    for (const loc of p.code ?? []) {
      const s = scoreLocation(loc, q);
      if (s.score > 0 && (!best || s.score > best.score || (s.score === best.score && p.name.localeCompare(best.project.name) < 0))) {
        best = { project: p, score: s.score, location: loc, how: s.how };
      }
    }
  }
  return best;
}

/** The repo's own name from the query: last segment of the remote, else of the path. */
export function repoName(query: CodeQuery): string {
  const r = normalizeRemote(query.remote);
  if (r) return r.split('/')[1];
  const p = normalizePath(query.path);
  return p ? (p.split('/').pop() ?? '') : '';
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 0..1 similarity between two names (alphanumerics only, case-insensitive). */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8 + 0.1 * (Math.min(x.length, y.length) / Math.max(x.length, y.length));
  const bx = bigrams(x);
  const by = bigrams(y);
  if (!bx.length || !by.length) return 0;
  const pool = [...by];
  let hits = 0;
  for (const g of bx) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (bx.length + by.length) * 0.8;
}

/** Top projects by name similarity to the repo name, for "which project is this?". */
export function codeCandidates(projects: CodeProject[], query: CodeQuery, limit = 5): { project: CodeProject; similarity: number }[] {
  const name = repoName(query);
  return projects
    .map(project => ({ project, similarity: Math.round(nameSimilarity(name, project.name) * 100) / 100 }))
    .sort((a, b) => b.similarity - a.similarity || a.project.name.localeCompare(b.project.name))
    .slice(0, limit);
}
