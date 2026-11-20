// The Work OS skills (slash commands such as /transfer and /declutter) that the worker installs into Claude Code beside
// the hooks (docs/setup-pc.md step 3). Sources: worker/skills/<name>/SKILL.md, carried in the download and the signed
// bundle. Each installed folder ~/.claude/skills/<name>/ holds a `.work-os-managed` file with its version; only folders
// with that file are ever replaced or removed. A folder of the same name without it is the person's own skill: it is
// left alone until they ask for it to be replaced (`hooks install --adopt <name>`; the old folder is kept in the worker's
// config folder, skills-backup/). Symbolic links are never followed or replaced.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.mjs';

export const MARKER = '.work-os-managed';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const here = path.dirname(fileURLToPath(import.meta.url));

/** Where Claude Code reads personal skills: beside its settings.json (~/.claude/skills). CLAUDE_SKILLS_DIR overrides it, and so
 * does CLAUDE_SETTINGS_PATH (its folder), so a test that moves the settings never writes into the real ~/.claude. */
export const skillsTarget = () => process.env.CLAUDE_SKILLS_DIR
  || path.join(process.env.CLAUDE_SETTINGS_PATH ? path.dirname(process.env.CLAUDE_SETTINGS_PATH) : path.join(os.homedir(), '.claude'), 'skills');
export const skillsSource = (dir = here) => path.join(dir, 'skills');

/** A skill's version: a short hash of its text, line endings ignored (a Windows checkout and the bundle agree). */
export const skillVersion = (text) => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);

/** The skills this worker carries: [{ name, text, version }]. */
export function skillSources(src = skillsSource()) {
  let names = [];
  try { names = fs.readdirSync(src).filter((n) => NAME_RE.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    try { const text = fs.readFileSync(path.join(src, name, 'SKILL.md'), 'utf8'); out.push({ name, text, version: skillVersion(text) }); } catch { /* no SKILL.md */ }
  }
  return out;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const readMarker = (p) => { try { return fs.readFileSync(path.join(p, MARKER), 'utf8').trim(); } catch { return null; } };

/** 'missing' | 'own' (not ours: no marker, a link, or not a folder) | 'current' | 'stale' (ours, another version). */
export function skillState(target, name, version) {
  const p = path.join(target, name);
  const st = lstat(p);
  if (!st) return 'missing';
  if (st.isSymbolicLink() || !st.isDirectory()) return 'own';
  const m = readMarker(p);
  if (m === null) return 'own';
  return m === version && fs.existsSync(path.join(p, 'SKILL.md')) ? 'current' : 'stale';
}

/** What each carried skill looks like in `target`: [{ name, state }]. */
export function skillsStatus({ target = skillsTarget(), src = skillsSource() } = {}) {
  return skillSources(src).map((s) => ({ name: s.name, state: skillState(target, s.name, s.version) }));
}

/** Writes one skill folder through a temp folder and a rename, so Claude Code never reads half of it. */
function put(target, s) {
  const p = path.join(target, s.name);
  const tmp = path.join(target, `.${s.name}.work-os-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'SKILL.md'), s.text);
  fs.writeFileSync(path.join(tmp, MARKER), s.version + '\n');
  if (lstat(p)) fs.rmSync(p, { recursive: true, force: true }); // only reached for our own (marked) folder, or one being adopted after its backup
  fs.renameSync(tmp, p);
}

/** Moves a person's own folder aside before it is adopted (never deleted). */
function backup(p, name, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const to = path.join(backupDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try { fs.renameSync(p, to); } catch { fs.cpSync(p, to, { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); }
  return to;
}

/**
 * Installs or refreshes the carried skills in `target`. Replaces only folders that carry the marker; `adopt` names
 * folders without it that the person asked to replace (moved to `backupDir` first). Marked folders of skills this
 * worker no longer carries are removed. Returns { installed, current, own, removed, backups }.
 */
export function installSkills({ target = skillsTarget(), src = skillsSource(), adopt = [], backupDir = path.join(configDir(), 'skills-backup') } = {}) {
  const sources = skillSources(src);
  for (const a of adopt) if (!sources.some((s) => s.name === a)) throw new Error(`no Work OS skill named ${String(a).slice(0, 40)} (this worker carries: ${sources.map((s) => s.name).join(', ') || 'none'})`);
  const tst = lstat(target);
  if (tst && (tst.isSymbolicLink() ? !fs.statSync(target).isDirectory() : !tst.isDirectory())) throw new Error(`${target} is not a folder`);
  fs.mkdirSync(target, { recursive: true });
  const out = { installed: [], current: [], own: [], removed: [], backups: [] };
  for (const s of sources) {
    const state = skillState(target, s.name, s.version);
    if (state === 'current') { out.current.push(s.name); continue; }
    if (state === 'own') {
      const st = lstat(path.join(target, s.name));
      if (!adopt.includes(s.name) || st.isSymbolicLink()) { out.own.push(s.name); continue; }
      out.backups.push(backup(path.join(target, s.name), s.name, backupDir));
    }
    put(target, s);
    out.installed.push(s.name);
  }
  out.removed = removeSkills({ target, keep: sources.map((s) => s.name) });
  return out;
}

/** Removes the marked (Work OS) skill folders in `target`, except the names in `keep`. Folders without the marker and links stay. */
export function removeSkills({ target = skillsTarget(), keep = [] } = {}) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(target); } catch { return removed; }
  for (const name of names) {
    if (!NAME_RE.test(name) || keep.includes(name)) continue;
    const p = path.join(target, name);
    const st = lstat(p);
    if (!st || st.isSymbolicLink() || !st.isDirectory() || readMarker(p) === null) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** The lines `hooks status` and `worker.mjs status` print about the skills. */
export function describeSkills(list) {
  return list.map(({ name, state }) => `${name}: ${{
    current: 'installed (current)',
    stale: 'installed, out of date (the worker refreshes it at its next start; or run: hooks install)',
    missing: 'not installed (run: hooks install)',
    own: `your own skill, not replaced (to use the Work OS one instead: hooks install --adopt ${name}; yours is kept in the worker's config folder)`,
  }[state]}`);
}
