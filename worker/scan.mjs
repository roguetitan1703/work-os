import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeRemote } from './remote.mjs';
import { readMarker, WRITER } from './markers.mjs';

const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.git']);
const PROJECT_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'pubspec.yaml', 'manage.py'];
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  } catch { return ''; }
}

export function newId() { return 'f_' + crypto.randomBytes(9).toString('base64url').slice(0, 12); }

// knownIds: absolute path -> folderId (local state). Returns folders including a local-only `path`.
export function scanRoots({ roots, maxDepth = 6, knownIds = {} }) {
  const out = [];
  const usedIds = new Set();
  const multi = roots.length > 1;
  for (const root of roots) {
    let rootReal;
    try { rootReal = fs.realpathSync(root); } catch { continue; }
    const describe = (dir, isGit) => {
      let rel = path.relative(rootReal, dir).split(path.sep).join('/');
      if (!rel) rel = path.basename(rootReal);
      else if (multi) rel = path.basename(rootReal) + '/' + rel;
      const marker = readMarker(dir);
      let id = marker && marker.writtenBy === WRITER && ID_RE.test(marker.folderId || '') ? marker.folderId : null;
      if (!id || usedIds.has(id)) id = knownIds[dir];
      if (!id || usedIds.has(id) || !ID_RE.test(id)) id = newId();
      usedIds.add(id);
      const f = { id, name: rel.slice(0, 120), git: isGit, path: dir };
      if (isGit) {
        const remote = normalizeRemote(git(dir, ['remote', 'get-url', 'origin']));
        if (remote) f.remote = remote;
        const branch = git(dir, ['branch', '--show-current']).slice(0, 120);
        if (branch) f.branch = branch;
      }
      return f;
    };
    const walk = (dir, depth, gitOnly) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const names = new Set(entries.map((e) => e.name));
      const isGit = names.has('.git');
      const hasProj = PROJECT_FILES.some((f) => names.has(f)) || entries.some((e) => e.isFile() && e.name.endsWith('.csproj'));
      const counted = isGit || (!gitOnly && hasProj);
      if (counted) out.push(describe(dir, isGit));
      // below a counted folder, only nested git repos count
      const childGitOnly = gitOnly || counted;
      if (depth < maxDepth) {
        for (const e of entries) {
          if (!e.isDirectory() || SKIP.has(e.name)) continue; // symlinks are not followed
          walk(path.join(dir, e.name), depth + 1, childGitOnly);
        }
      }
    };
    walk(rootReal, 0, false);
  }
  return out.slice(0, 3000);
}

export const publicFolder = ({ path: _p, ...rest }) => rest;
