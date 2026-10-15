import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Folder trust: linking a folder in Work OS marks it trusted in Claude Code
// (projects["<path>"].hasTrustDialogAccepted = true in ~/.claude.json). Never untrusts.

export function claudeJsonPath() {
  return process.env.WORK_OS_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
}

// Claude's key format: forward slashes, uppercase drive letter.
export function trustKey(dir) {
  let p = path.resolve(dir).split(path.win32.sep).join('/');
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p;
}

function canon(k) {
  let p = String(k).split(path.win32.sep).join('/');
  if (/^[A-Za-z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// Returns 'set' | 'already' | 'skipped'. Never throws.
export function trustFolder(dir, log = () => {}, depth = 0) {
  const file = claudeJsonPath();
  try {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') raw = null; else { log('trust: cannot read claude.json: ' + e.message); return 'skipped'; }
    }
    let data = {};
    if (raw !== null) {
      try { data = JSON.parse(raw); } catch { log('trust: claude.json is not valid JSON, skipped'); return 'skipped'; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { log('trust: claude.json is not an object, skipped'); return 'skipped'; }
    }
    if (data.projects !== undefined && (data.projects === null || typeof data.projects !== 'object' || Array.isArray(data.projects))) {
      log('trust: claude.json "projects" has an unexpected shape, skipped'); return 'skipped';
    }
    const key = trustKey(dir);
    const want = canon(key);
    const projects = data.projects || {};
    const matches = Object.keys(projects).filter((k) => canon(k) === want);
    const entries = matches.length ? matches : [key];
    const needs = entries.filter((k) => !(projects[k] && typeof projects[k] === 'object' && projects[k].hasTrustDialogAccepted === true));
    if (!needs.length) return 'already';
    for (const k of needs) {
      const cur = projects[k];
      if (cur !== undefined && (cur === null || typeof cur !== 'object' || Array.isArray(cur))) { log('trust: project entry has an unexpected shape, skipped'); return 'skipped'; }
      projects[k] = cur ? { ...cur, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true };
    }
    data.projects = projects;
    // Claude writes this file often: re-read right before writing; bail if it changed or broke.
    let again = null;
    try { again = fs.readFileSync(file, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') { log('trust: re-read failed, skipped'); return 'skipped'; } }
    if (again !== raw) return depth < 3 ? trustFolder(dir, log, depth + 1) : 'skipped'; // changed underneath us: redo once from fresh content
    const tmp = path.join(path.dirname(file), `.claude.json.workos-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    log('trust: marked ' + key + ' as trusted');
    return 'set';
  } catch (e) {
    log('trust failed: ' + (e && e.message ? e.message : e));
    return 'skipped';
  }
}
