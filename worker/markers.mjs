import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MARKER = '.workos.json';
export const WRITER = 'work-os-worker';

export function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

export function excludePath(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    return out ? path.resolve(dir, out) : null;
  } catch { return null; }
}

// Idempotent. Returns true if the line was added.
export function addExclude(dir) {
  const p = excludePath(dir);
  if (!p) return false;
  let cur = '';
  try { cur = fs.readFileSync(p, 'utf8'); } catch {}
  if (cur.split(/\r?\n/).some((l) => l.trim() === MARKER)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + MARKER + '\n');
  return true;
}

// Writes only if no marker exists or the existing one is ours. Returns 'written' | 'same' | 'foreign'.
export function writeMarker(dir, { projectId, projectName, folderId }) {
  const existing = readMarker(dir);
  if (fs.existsSync(path.join(dir, MARKER)) && (!existing || existing.writtenBy !== WRITER)) return 'foreign';
  const data = { v: 1, project: projectId, projectName, folderId, writtenBy: WRITER };
  const same = existing && JSON.stringify(existing) === JSON.stringify(data);
  if (!same) fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(data) + '\n');
  addExclude(dir);
  return same ? 'same' : 'written';
}

export function removeMarker(dir) {
  const existing = readMarker(dir);
  if (!existing || existing.writtenBy !== WRITER) return false;
  try { fs.unlinkSync(path.join(dir, MARKER)); return true; } catch { return false; }
}
