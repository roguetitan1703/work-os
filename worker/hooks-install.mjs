// Installs the Work OS hooks (hook.mjs) into Claude Code's user settings on this PC (docs/setup-pc.md).
//   node worker.mjs hooks install [--force]   copy the files of FILES to <worker config dir>/hooks and merge the hook
//                                   entries into ~/.claude/settings.json (a dated backup first; other settings and hooks
//                                   kept). A second worker (WORK_OS_WORKER_DIR set) does not take over hooks that point at
//                                   another folder unless --force.
//   node worker.mjs hooks remove    take the Work OS entries out again
//   node worker.mjs hooks status    say what is installed
//   node worker.mjs hooks repo [folder] [--server URL]   for a cloud repo (Claude Code on the web): copy the hook files to
//                                   <repo>/.claude/work-os/ and merge four entries into <repo>/.claude/settings.json that
//                                   run only in a cloud session and sign in with WORK_OS_KEY. Hooks only, never permissions.
//   node worker.mjs hooks check [folder]   would a Claude Code session in the folder (default: here) get the Work OS brief?
// Never touches ~/.claude.json. Safe to run again (it replaces its own entries only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkBaseUrl, configDir, loadConfig } from './config.mjs';
import { EVENTS } from './hook-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const settingsPath = () => process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
export const hooksDir = () => path.join(configDir(), 'hooks');
// The files the installed copy runs: the router, one file per event (and hook-lib, hook-copy), config.mjs and secret.mjs (the
// start hook reads this PC's device key with it: the worker's own code, so the key stays in DPAPI / Keychain).
export const FILES = ['hook.mjs', 'hook-lib.mjs', 'hook-copy.mjs', 'hook-session-start.mjs', 'hook-stop.mjs', 'hook-pre-tool.mjs', 'hook-post-tool.mjs', 'hook-user-prompt.mjs', 'hook-notification.mjs', 'hook-session-end.mjs', 'config.mjs', 'secret.mjs'];
const VERSION_FILE = 'hooks.version';
/** How the start brief signs in on this PC, first choice: 'worker' (the worker is set up; a WORK_OS_KEY is only its fallback), 'key' (WORK_OS_KEY set, no worker), or null. */
function signIn(settings) {
  try { if (loadConfig().baseUrl) return 'worker'; } catch { /* no worker config */ }
  return settings.env?.WORK_OS_KEY || process.env.WORK_OS_KEY ? 'key' : null;
}
/** The hooks version: a short hash of the hook files this worker carries (changes whenever any of them does). */
export function hooksVersion(dir = here) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 12);
}
/** The version of the installed copy (what was written at install), or null. */
export function installedVersion() {
  try { return fs.readFileSync(path.join(hooksDir(), VERSION_FILE), 'utf8').trim() || null; } catch { return null; }
}
// Every entry we write runs <some folder>/hooks/hook.mjs <event>; the folder's name is not ours to rely on (WORK_OS_WORKER_DIR).
const OURS_RE = new RegExp('[\\\\/]hooks[\\\\/]hook\\.mjs"\\s+(' + EVENTS.map((e) => e.event).join('|') + ')(\\s|$)');

/** The hook entries, by Claude Code event. `hook` is the absolute path of the installed hook.mjs; `flags` is appended to each command (a repo's: ` --cloud --server <url>`). */
export function entries(hook, flags = '', { cloud = false } = {}) {
  const h = hook.split(path.sep).join('/');
  const c = (e) => ({ type: 'command', command: `node "${h}" ${e.event}${flags}`, timeout: e.timeoutS, ...(e.async ? { async: true } : {}) });
  const out = {};
  for (const e of EVENTS) if (!(cloud && e.localOnly)) out[e.claudeEvent] = [{ ...(e.matcher ? { matcher: e.matcher } : {}), hooks: [c(e)] }];
  return out;
}

const ours = (group) => (group?.hooks || []).some((x) => OURS_RE.test(String(x.command || '')));
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${f} is not valid JSON; fix it first (${e.message})`); } };

/** The settings object with our entries removed (and empty events dropped). */
export function withoutOurs(settings) {
  const s = { ...settings };
  if (!s.hooks) return s;
  const hooks = {};
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const keep = (groups || []).filter((g) => !ours(g));
    if (keep.length) hooks[ev] = keep;
  }
  if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
  return s;
}

export function merge(settings, hook) {
  const s = withoutOurs(settings);
  s.hooks = { ...(s.hooks || {}) };
  for (const [ev, groups] of Object.entries(entries(hook))) s.hooks[ev] = [...(s.hooks[ev] || []), ...groups];
  return s;
}

function write(f, obj) {
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`; // same folder, then a rename: a reader never sees half a file
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

/** The installed hook.mjs of this worker, in the form the settings commands use (forward slashes). */
const ownHook = () => path.join(hooksDir(), 'hook.mjs').split(path.sep).join('/');
const sameFile = (x, y) => (process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y);
/** The hook.mjs paths our settings entries run. */
function entryHooks(settings) {
  const out = new Set();
  for (const groups of Object.values(settings.hooks || {})) {
    for (const g of groups || []) {
      if (!ours(g)) continue;
      for (const x of g.hooks || []) { const m = /^node "(.+hook\.mjs)"/.exec(String(x.command || '')); if (m) out.add(m[1]); }
    }
  }
  return [...out];
}
/** True when our settings entries run this worker's own installed hook (or there are none). */
function ownsEntries(settings) {
  const hooks = entryHooks(settings);
  return hooks.every((h) => sameFile(h, ownHook()));
}

/** Copies the hook files one by one through a temp name and a rename (hook.mjs last), so a session that starts mid-copy never imports a missing file. */
function copyFiles(dir) {
  const put = (f) => {
    const tmp = path.join(dir, `.${f}.${process.pid}.tmp`);
    fs.copyFileSync(path.join(here, f), tmp);
    fs.renameSync(tmp, path.join(dir, f));
  };
  for (const f of FILES.filter((x) => x !== 'hook.mjs')) put(f);
  put('hook.mjs');
  // Hook files an older worker carried and this one does not.
  for (const f of fs.readdirSync(dir)) if (/^hook-.*\.mjs$/.test(f) && !FILES.includes(f)) fs.rmSync(path.join(dir, f), { force: true });
}

export function install({ force = false } = {}) {
  const f = settingsPath();
  const current = read(f);
  if (!force && process.env.WORK_OS_WORKER_DIR && !ownsEntries(current)) {
    throw new Error(`the Work OS hooks in ${f} run ${entryHooks(current)[0]}, not this worker folder (WORK_OS_WORKER_DIR); run hooks install --force to move them here`);
  }
  const dir = hooksDir();
  fs.mkdirSync(dir, { recursive: true });
  copyFiles(dir);
  const version = hooksVersion();
  fs.writeFileSync(path.join(dir, VERSION_FILE), version + '\n');
  const hook = path.join(dir, 'hook.mjs');
  write(f, merge(current, hook));
  return { hook, version, settings: f, signIn: signIn(read(f)) };
}

export function remove() {
  const f = settingsPath();
  const s = read(f);
  try { fs.rmSync(path.join(hooksDir(), VERSION_FILE), { force: true }); } catch {}
  if (!s.hooks || !Object.values(s.hooks).flat().some(ours)) return false;
  write(f, withoutOurs(s));
  return true;
}

const ourEvents = (s) => Object.entries(s.hooks || {}).filter(([, g]) => (g || []).some(ours)).map(([ev]) => ev);

/** True when hooks are installed here but the installed copy is not the one this worker carries. */
export function isStale() {
  try { return ourEvents(read(settingsPath())).length > 0 && installedVersion() !== hooksVersion(); } catch { return false; }
}

/** True when the settings entries run another worker's hooks folder: this worker must not refresh them (a second worker never takes over). */
function runsElsewhere() {
  try { const s = read(settingsPath()); return ourEvents(s).length > 0 && !ownsEntries(s); } catch { return false; }
}

/** Re-run install when the installed hooks are out of date (after a worker update). Never throws. Returns the new version or null. */
export function refreshIfStale() {
  try { return isStale() && !runsElsewhere() ? install().version : null; } catch { return null; }
}

export function status() {
  const s = read(settingsPath());
  const events = ourEvents(s);
  return { settings: settingsPath(), events, hookFile: fs.existsSync(path.join(hooksDir(), 'hook.mjs')), version: installedVersion(), current: hooksVersion(), stale: isStale(), signIn: signIn(s) };
}

const SIGN_IN = {
  worker: "The start brief and the stop check sign in with this PC's worker key, for projects with a folder linked to them on this PC (Claude › Setup or the project's Code tab).",
  key: 'WORK_OS_KEY is set: the start brief and the stop check use it (this PC has no worker; with one, the worker is used first and the key is only the fallback).',
  workerKey: "WORK_OS_KEY is set: the worker is used first (this PC's worker key, which also reports the session's state) and the key is only the fallback when the worker gives no brief.",
  none: 'The WORK-STATE.md copy and its edit guard work now; the start brief and the stop check turn on once the worker is set up here (node worker.mjs setup).',
};

const REPO_MARK = '.claude/work-os/hook.mjs';
const repoOurs = (group) => (group?.hooks || []).some((x) => String(x.command || '').includes(REPO_MARK));

/**
 * Puts the hooks into a repo for cloud sessions (Claude Code on the web has no worker): the files under .claude/work-os/ and
 * four entries in .claude/settings.json (its other settings and hooks kept; rerun replaces only these entries). The entries
 * carry --cloud, so the hooks run nothing on a PC (the global hooks do), and --server, the address a cloud session has no
 * worker config for. The session signs in with WORK_OS_KEY from the cloud environment's variables.
 */
export function repo(folder = process.cwd(), { server } = {}) {
  const top = gitTop(path.resolve(folder));
  if (!top) throw new Error(`${folder} is not inside a git repo`);
  const base = server || loadConfig().baseUrl;
  if (!base) throw new Error('no Work OS address: set up this worker first (node worker.mjs setup) or pass --server https://...');
  const origin = checkBaseUrl(base);
  const dir = path.join(top, '.claude', 'work-os');
  refuseLinks(top, ['.claude', 'work-os']);
  fs.mkdirSync(dir, { recursive: true });
  refuseLinks(top, ['.claude', 'work-os']);
  copyFiles(dir);
  const file = path.join(top, '.claude', 'settings.json');
  const s = read(file);
  const hooks = {};
  for (const [ev, groups] of Object.entries(s.hooks || {})) { const keep = (groups || []).filter((g) => !repoOurs(g)); if (keep.length) hooks[ev] = keep; }
  for (const [ev, groups] of Object.entries(entries(`$CLAUDE_PROJECT_DIR/${REPO_MARK}`, ` --cloud --server "${origin}"`, { cloud: true }))) hooks[ev] = [...(hooks[ev] || []), ...groups];
  fs.writeFileSync(file, JSON.stringify({ ...s, hooks }, null, 2) + '\n');
  return { dir, settings: file, server: origin };
}
/** A symlink or junction at .claude or .claude/work-os would let a hostile repo aim our writes and the stale-file cleanup elsewhere. */
function refuseLinks(top, parts) {
  let p = top;
  for (const part of parts) {
    p = path.join(p, part);
    let st = null;
    try { st = fs.lstatSync(p); } catch { /* not there yet */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${p} is a link or not a folder; refusing to write hooks through it`);
  }
}
function gitTop(cwd) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** The line `hooks check` prints. */
export const describeCheck = (r) => (r.ok
  ? `Brief for project ${r.project}, signed in with ${r.via === 'key' ? 'WORK_OS_KEY' : "this PC's worker key"}`
  : `No brief: ${r.reason}`);

/** Would a session in `folder` get the brief? Runs the *installed* copy's check (what Claude Code runs), not this worker's. */
export async function check(folder = process.cwd()) {
  const file = path.join(hooksDir(), 'hook-session-start.mjs');
  if (!fs.existsSync(file)) return { ok: false, via: null, reason: 'the hooks are not installed (run: node worker.mjs hooks install)' };
  return (await import(pathToFileURL(file).href)).startCheck(path.resolve(folder));
}

export async function cli(sub, rest = []) {
  if (sub === 'install') {
    const r = install({ force: rest.includes('--force') });
    console.log(`Work OS hooks installed in ${r.settings} (hook: ${r.hook}, version ${r.version}).`);
    console.log(SIGN_IN[r.signIn === 'worker' && (process.env.WORK_OS_KEY || read(settingsPath()).env?.WORK_OS_KEY) ? 'workerKey' : r.signIn ?? 'none']);
    console.log('Open Claude Code sessions pick this up on their next tool call; restart them to get the start brief.');
  } else if (sub === 'remove') console.log(remove() ? 'Work OS hooks removed.' : 'No Work OS hooks were installed.');
  else if (sub === 'status') console.log(JSON.stringify(status(), null, 2));
  else if (sub === 'repo') {
    const i = rest.indexOf('--server');
    const folder = rest.find((x, j) => !x.startsWith('--') && j !== i + 1);
    const r = repo(folder, { server: i >= 0 ? rest[i + 1] : undefined });
    console.log(`Work OS hooks for cloud sessions written to ${r.dir} and ${r.settings} (server ${r.server}). Commit both.`);
    console.log('In the cloud environment: set WORK_OS_KEY to a Claude Code key made for it (Work OS › Settings › Keys), and allow the Work OS address in its network settings.');
  } else if (sub === 'check') {
    const r = await check(rest.find((x) => !x.startsWith('--')));
    console.log(describeCheck(r));
    if (!r.ok) process.exitCode = 1;
  } else { console.error('usage: node worker.mjs hooks [install [--force]|remove|status|check [folder]|repo [folder] [--server URL]]'); process.exitCode = 2; }
}
