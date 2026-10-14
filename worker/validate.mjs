import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['start', 'resume', 'stop'];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROMPT = 4000;

// Returns the realpath of dir if it is inside one of the roots (after resolving symlinks), else null.
export function insideRoot(dir, roots) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return null; }
  for (const r of roots) {
    let rr;
    try { rr = fs.realpathSync(r); } catch { continue; }
    const rel = path.relative(rr, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real;
  }
  return null;
}

// folders: id -> absolute path (local only). Returns { ok, error?, dir? }.
export function validateJob(job, { folders, roots }) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'bad job' };
  if (!KINDS.includes(job.kind)) return { ok: false, error: 'unknown job kind' };
  if (typeof job.sessionId !== 'string' || !UUID_RE.test(job.sessionId)) return { ok: false, error: 'bad session id' };
  if (job.prompt !== undefined && job.prompt !== null) {
    if (typeof job.prompt !== 'string') return { ok: false, error: 'bad prompt' };
    if (job.prompt.length > MAX_PROMPT) return { ok: false, error: 'prompt too long' };
  }
  if (job.kind === 'stop') return { ok: true };
  if (typeof job.folderId !== 'string' || !Object.prototype.hasOwnProperty.call(folders, job.folderId)) {
    return { ok: false, error: 'unknown folder' };
  }
  const dir = insideRoot(folders[job.folderId], roots);
  if (!dir) return { ok: false, error: 'folder outside allowed roots' };
  return { ok: true, dir };
}
