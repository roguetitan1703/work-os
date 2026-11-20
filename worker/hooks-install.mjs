// Installs the Work OS hooks (hook.mjs) into Claude Code's user settings on this PC (docs/setup-pc.md).
// It also installs the Work OS skills (/transfer, /declutter: worker/skills, skills-install.mjs) into ~/.claude/skills.
//   node worker.mjs hooks install [--force] [--adopt NAME]   copy the files of FILES to <worker config dir>/hooks and merge the hook
//                                   entries into ~/.claude/settings.json (a dated backup first; other settings and hooks
//                                   kept). A second worker (WORK_OS_WORKER_DIR set) does not take over hooks that point at
//                                   another folder unless --force. Skills: only folders marked as the worker's are
//                                   replaced; --adopt NAME replaces the person's own folder of that name (kept as a backup).
//   node worker.mjs hooks remove    take the Work OS entries and the worker's skill folders out again
//   node worker.mjs hooks status    say what is installed
//   node worker.mjs hooks repo [folder] [--server URL] [--project ID]   for a cloud repo (Claude Code on the web): copy the hook files to
//                                   <repo>/.claude/work-os/ and merge four entries into <repo>/.claude/settings.json that
//                                   run only in a cloud session and sign in with WORK_OS_KEY. Hooks only, never permissions.
//                                   --project ID (the id in the project's Work OS address): the project this repo's cloud sessions
//                                   start on; without it a cloud session in the repo is unfiled and asks (H13). The skills
//                                   go to <repo>/.claude/skills (same marker rule).
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
import { installSkills, removeSkills, skillsStatus, describeSkills } from './skills-install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const settingsPath = () => process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
export const hooksDir = () => path.join(configDir(), 'hooks');
// The files the installed copy runs: the router, one file per event (and hook-lib, hook-copy), config.mjs and secret.mjs (the
// start hook reads this PC's device key with it: the worker's own code, so the key stays in DPAPI / Keychain).
export const FILES = ['hook.mjs', 'hook-lib.mjs', 'hook-identity.mjs', 'claude-account.mjs', 'hook-copy.mjs', 'hook-release.mjs', 'remote.mjs', 'hook-session-start.mjs', 'hook-stop.mjs', 'hook-pre-tool.mjs', 'hook-post-tool.mjs', 'hook-user-prompt.mjs', 'hook-notification.mjs', 'hook-session-end.mjs', 'hook-subagent-start.mjs', 'hook-subagent-stop.mjs', 'hook-tool-batch.mjs', 'hook-tool-start.mjs', 'hook-wait.mjs', 'hook-gate.mjs', 'config.mjs', 'secret.mjs'];
const VERSION_FILE = 'hooks.version';
/** How the start brief signs in on this PC, first choice: 'worker' (the worker is set up; a WORK_OS_KEY is only its fallback), 'key' (WORK_OS_KEY set, no worker), or null. */
function signIn(settings) {
  try { if (loadConfig().baseUrl) return 'worker'; } catch { /* no worker config */ }
  return settings.env?.WORK_OS_KEY || process.env.WORK_OS_KEY ? 'key' : null;
}
/** The hooks version: a short hash of the hook files this worker carries (changes whenever any of them does). Line endings
 * do not count: a Windows checkout (CRLF) and the downloaded bundle (LF) of the same commit get the same version. */
export function hooksVersion(dir = here) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) h.update(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  return h.digest('hex').slice(0, 12);
}
/** The version of the installed copy (what was written at install), or null. */
export function installedVersion() {
  try { return fs.readFileSync(path.join(hooksDir(), VERSION_FILE), 'utf8').trim() || null; } catch { return null; }
}
// Every entry we write runs <some folder>/hooks/hook.mjs <event>; the folder's name is not ours to rely on (WORK_OS_WORKER_DIR).
// Events a past install wrote and this one no longer does (hooks review 18, 21 Nov: subagent-stop): still ours, so an install removes them.
const RETIRED_EVENTS = ['subagent-stop'];
const OURS_RE = new RegExp('[\\\\/]hooks[\\\\/]hook\\.mjs"\\s+(' + [...EVENTS.map((e) => e.event), ...RETIRED_EVENTS].join('|') + ')(\\s|$)');

/** The hook entries, by Claude Code event. `hook` is the absolute path of the installed hook.mjs; `flags` is appended to each command (a repo's: ` --cloud --server <url>`). */
export function entries(hook, flags = '', { cloud = false } = {}) {
  const h = hook.split(path.sep).join('/');
  const c = (e) => ({ type: 'command', command: `node "${h}" ${e.event}${flags}`, timeout: e.timeoutS, ...(e.async ? { async: true } : {}), ...(e.asyncRewake ? { asyncRewake: true } : {}) });
  const out = {};
  // Several rows of one Claude Code event (Stop: the stop check and the idle wait) are several groups under it.
  for (const e of EVENTS) if (!(cloud && e.localOnly)) out[e.claudeEvent] = [...(out[e.claudeEvent] || []), { ...(e.matcher ? { matcher: e.matcher } : {}), hooks: [c(e)] }];
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

export function install({ force = false, adopt = [] } = {}) {
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
  // The skills. A failure here (a locked folder) never undoes the hooks: it is reported, and retried at the next start.
  let skills;
  try { skills = installSkills({ adopt }); } catch (e) { if (adopt.length) throw e; skills = { error: String(e.message || e).split('\n')[0].slice(0, 300) }; }
  return { hook, version, settings: f, signIn: signIn(read(f)), skills, skillLines: skillLines(skills) };
}

/** Takes the Work OS entries out of the settings and removes the worker's (marked) skill folders. Returns { hooks: was any entry removed, skills: the removed skill names }. */
export function remove() {
  const f = settingsPath();
  const s = read(f);
  try { fs.rmSync(path.join(hooksDir(), VERSION_FILE), { force: true }); } catch {}
  let skills = [];
  try { skills = removeSkills(); } catch { /* a locked folder stays */ }
  if (!s.hooks || !Object.values(s.hooks).flat().some(ours)) return { hooks: false, skills };
  write(f, withoutOurs(s));
  return { hooks: true, skills };
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

/** At worker start: bring the skills up to date when this worker's hooks are installed (a worker that runs another
 * worker's hooks, or none, leaves them alone). Never throws. Returns the names installed or refreshed. */
export function refreshSkills() {
  try {
    const s = read(settingsPath());
    if (!ourEvents(s).length || !ownsEntries(s)) return [];
    return installSkills().installed;
  } catch { return []; }
}

export function status() {
  const s = read(settingsPath());
  const events = ourEvents(s);
  return { settings: settingsPath(), events, hookFile: fs.existsSync(path.join(hooksDir(), 'hook.mjs')), version: installedVersion(), current: hooksVersion(), stale: isStale(), signIn: signIn(s), skills: skillsStatus() };
}

const SIGN_IN = {
  worker: "The start brief and the stop check sign in with this PC's worker key, for projects with a folder linked to them on this PC (Claude › Setup or the project's Code tab).",
  key: 'WORK_OS_KEY is set: the start brief and the stop check use it (this PC has no worker; with one, the worker is used first and the key is only the fallback).',
  workerKey: "WORK_OS_KEY is set: the worker is used first (this PC's worker key, which also reports the session's state) and the key is only the fallback when the worker gives no brief.",
  none: 'The WORK-STATE.md copy and its edit guard work now; the start brief and the stop check turn on once the worker is set up here (node worker.mjs setup).',
};

/** What an install says about the skills: what it put in, and each folder it left because it is the person's own. */
export function skillLines(r) {
  if (!r) return [];
  if (r.error) return [`Work OS skills not installed: ${r.error} (retried at the worker's next start)`];
  const out = [];
  const put = [...r.installed, ...r.current].sort();
  if (put.length) out.push(`Work OS skills: ${put.map((n) => '/' + n).join(', ')}${r.installed.length ? ` (installed now: ${r.installed.join(', ')})` : ' (current)'}`);
  for (const b of r.backups) out.push(`your own copy was moved to ${b}`);
  out.push(...describeSkills(r.own.map((name) => ({ name, state: 'own' }))));
  return out;
}

const REPO_MARK = '.claude/work-os/hook.mjs';
const repoOurs = (group) => (group?.hooks || []).some((x) => String(x.command || '').includes(REPO_MARK));

/**
 * Puts the hooks into a repo for cloud sessions (Claude Code on the web has no worker): the files under .claude/work-os/ and
 * four entries in .claude/settings.json (its other settings and hooks kept; rerun replaces only these entries). The entries
 * carry --cloud, so the hooks run nothing on a PC (the global hooks do), and --server, the address a cloud session has no
 * worker config for. The session signs in with WORK_OS_KEY from the cloud environment's variables.
 */
export function repo(folder = process.cwd(), { server, project } = {}) {
  if (project !== undefined && project !== null && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(project)) throw new Error('--project is the project id (the last part of its Work OS address, lowercase letters, digits, dot, dash), not its name');
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
  // The skills too (a cloud session has no worker to install them): <repo>/.claude/skills/<name>, same marker rule.
  refuseLinks(top, ['.claude', 'skills']);
  const skills = installSkills({ target: path.join(top, '.claude', 'skills') });
  const file = path.join(top, '.claude', 'settings.json');
  const s = read(file);
  const hooks = {};
  for (const [ev, groups] of Object.entries(s.hooks || {})) { const keep = (groups || []).filter((g) => !repoOurs(g)); if (keep.length) hooks[ev] = keep; }
  for (const [ev, groups] of Object.entries(entries(`$CLAUDE_PROJECT_DIR/${REPO_MARK}`, ` --cloud --server "${origin}"${project ? ` --project "${project}"` : ''}`, { cloud: true }))) hooks[ev] = [...(hooks[ev] || []), ...groups];
  fs.writeFileSync(file, JSON.stringify({ ...s, hooks }, null, 2) + '\n');
  return { dir, settings: file, server: origin, project: project || null, skills };
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
    const a = rest.indexOf('--adopt');
    if (a >= 0 && (!rest[a + 1] || rest[a + 1].startsWith('--'))) throw new Error('--adopt needs the skill name, e.g. hooks install --adopt transfer');
    const r = install({ force: rest.includes('--force'), adopt: a >= 0 ? [rest[a + 1]] : [] });
    console.log(`Work OS hooks installed in ${r.settings} (hook: ${r.hook}, version ${r.version}).`);
    for (const line of r.skillLines) console.log(line);
    console.log(SIGN_IN[r.signIn === 'worker' && (process.env.WORK_OS_KEY || read(settingsPath()).env?.WORK_OS_KEY) ? 'workerKey' : r.signIn ?? 'none']);
    console.log('Open Claude Code sessions pick this up on their next tool call; restart them to get the start brief.');
  } else if (sub === 'remove') {
    const r = remove();
    console.log(r.hooks ? 'Work OS hooks removed.' : 'No Work OS hooks were installed.');
    if (r.skills.length) console.log(`Work OS skills removed: ${r.skills.join(', ')} (your own skills were left).`);
  } else if (sub === 'status') {
    const s = status();
    console.log(JSON.stringify(s, null, 2));
    for (const line of describeSkills(s.skills)) console.log(line);
  }
  else if (sub === 'repo') {
    const i = rest.indexOf('--server');
    const k = rest.indexOf('--project');
    const folder = rest.find((x, j) => !x.startsWith('--') && j !== i + 1 && j !== k + 1);
    const r = repo(folder, { server: i >= 0 ? rest[i + 1] : undefined, project: k >= 0 ? rest[k + 1] : undefined });
    console.log(`Work OS hooks for cloud sessions written to ${r.dir} and ${r.settings} (server ${r.server}${r.project ? `, project ${r.project}` : ''}). Commit both, and .claude/skills.`);
    for (const line of skillLines(r.skills)) console.log(line);
    if (!r.project) console.log('No --project: a cloud session in this repo is unfiled and asks its person which project it is for. Pass --project <id> (the last part of the address of the project in Work OS) to start it on one.');
    console.log('In the cloud environment: set WORK_OS_KEY to a Claude Code key made for it (Work OS › Settings › Keys), and allow the Work OS address in its network settings.');
  } else if (sub === 'check') {
    const r = await check(rest.find((x) => !x.startsWith('--')));
    console.log(describeCheck(r));
    if (!r.ok) process.exitCode = 1;
  } else { console.error('usage: node worker.mjs hooks [install [--force] [--adopt NAME]|remove|status|check [folder]|repo [folder] [--server URL] [--project ID]]'); process.exitCode = 2; }
}
