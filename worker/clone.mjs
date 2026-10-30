import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { insideRoot, UUID_RE, MAX_PROMPT } from './validate.mjs';
import { normalizeRemote } from './remote.mjs';
import { writeMarker } from './markers.mjs';
import { trustFolder } from './trust.mjs';

// Turbo mode (docs/launcher.md "Turbo mode"): a start job for a project whose repo is not on this PC makes the folder, clones the
// repo, links the folder and starts Claude there. Anyone who can start a session here can already have Claude clone anything, so
// there is no confirmation; the hard guards are the ones below: git transports that run commands are refused, git cannot prompt,
// there is a time limit, the destination stays inside the projects folder, and `allowClone: false` turns it all off.

export const CLONE_TIMEOUT_MS = 8 * 60_000; // below the server's 10 minute re-offer of an unfinished job
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const PART_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class CloneError extends Error {
  constructor(message, kind = 'failed') { super(message); this.kind = kind; }
}

/**
 * The repo a project points at -> what git is given. `owner/name` means GitHub; a full https:// URL, ssh:// URL or git@host:path is
 * used as given (any host). Refused: transports that run commands (ext::, fd::, any helper::), file:, git:, http:, local paths,
 * anything starting with "-". Returns { url, name (folder name), display (owner/name) }.
 */
export function cloneUrl(spec) {
  const bad = (why) => new CloneError(`Couldn't clone: ${why}`, 'refused');
  if (typeof spec !== 'string') throw bad('the project has no repository');
  const s = spec.trim();
  if (!s || s.length > 400) throw bad('the repository address is empty or too long');
  if (/[\u0000-\u001f\s]/.test(s)) throw bad('the repository address has spaces or control characters');
  if (s.startsWith('-')) throw bad('the repository address is not valid');
  if (/^[A-Za-z0-9+.-]*::/.test(s) || s.includes('::')) throw bad('that kind of repository address is not allowed');
  if (/^[A-Za-z]:[\\/]/.test(s) || /^[\\/~.]/.test(s) || s.includes('\\')) throw bad('a folder on a computer is not a repository address');
  let url;
  let tail;
  const scheme = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (scheme) {
    const sc = scheme[1].toLowerCase();
    if (sc !== 'https' && sc !== 'ssh') throw bad(`${sc}:// addresses are not allowed; use https or ssh`);
    let u;
    try { u = new URL(s); } catch { throw bad('the repository address is not valid'); }
    if (!HOST_RE.test(u.hostname) || u.username.startsWith('-')) throw bad('the repository host is not valid');
    tail = u.pathname;
    url = s;
  } else {
    const scp = s.match(/^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):([^:].*)$/);
    if (scp && !s.includes('//')) {
      if (!HOST_RE.test(scp[2])) throw bad('the repository host is not valid');
      tail = scp[3];
      url = s; // git@host:path (ssh)
    } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
      const [owner, repo] = s.split('/');
      if (!PART_RE.test(owner) || !PART_RE.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo.replace(/\.git$/i, ''))) throw bad('the repository address is not valid');
      tail = `/${owner}/${repo}`;
      url = `https://github.com/${owner}/${repo.replace(/\.git$/i, '')}.git`;
    } else throw bad('the repository address is not valid');
  }
  const parts = tail.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === '.' || p === '..')) throw bad('the repository address needs owner/name');
  const [owner, repo] = parts.slice(-2);
  if (!PART_RE.test(owner) || !PART_RE.test(repo)) throw bad('the repository address is not valid');
  return { url, name: safeName(repo), display: `${owner}/${repo}` };
}

/** A folder name made from a repo name: plain characters, no leading dot, no reserved Windows names. */
export function safeName(name) {
  let n = String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/[. ]+$/, '').slice(0, 80);
  if (!n) n = 'repo';
  if (RESERVED.test(n)) n = `${n}-repo`;
  return n;
}

/** The git command line. An args array only: git is never run through a shell. */
export function gitArgs(url, dest) {
  return ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=never', 'clone', '--', url, dest];
}

export const projectsDirOf = (cfg) => (typeof cfg.projectsDir === 'string' && cfg.projectsDir ? cfg.projectsDir : (cfg.roots || [])[0] || null);

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const within = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

function gitRemoteOf(dir) {
  try { return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); } catch { return ''; }
}

/**
 * Where the clone goes: <projectsDir>/<name>; if that exists and is the same repo it is reused, if it is something else the next
 * is <name>-2, -3 ... It never leaves projectsDir and is never a scan root's own path. projectsDir must be inside a scan root,
 * because only folders under a root can be started. Returns { dest, reuse }.
 */
export function resolveDestination({ projectsDir, name, display, roots, remoteOf = gitRemoteOf }) {
  const fail = (why) => new CloneError(`Couldn't clone: ${why}`, 'destination');
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || RESERVED.test(name) || /[. ]$/.test(name)) throw fail('the folder name is not allowed');
  if (!projectsDir) throw fail('this PC has no projects folder yet (set projectsDir in the worker settings)');
  fs.mkdirSync(projectsDir, { recursive: true });
  const base = insideRoot(projectsDir, roots);
  if (!base) throw fail(`the projects folder ${projectsDir} is not inside a folder the worker scans`);
  const rootReals = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  const want = normalizeRemote(`https://x/${display}`);
  for (let i = 1; i <= 50; i++) {
    const folder = i === 1 ? name : `${name}-${i}`;
    const dest = path.resolve(base, folder);
    if (!within(dest, base) || rootReals.some((r) => same(r, dest))) continue; // stays inside projectsDir, never a root itself
    let st = null;
    try { st = fs.lstatSync(dest); } catch {}
    if (!st) return { dest, reuse: false };
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (fs.existsSync(path.join(dest, '.git'))) {
      const got = normalizeRemote(remoteOf(dest));
      if (got && want && got.split('/').slice(-2).join('/') === want.split('/').slice(-2).join('/')) return { dest, reuse: true };
    }
  }
  throw fail(`the folder ${path.resolve(base, name)} is something else`);
}

function killTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { try { child.kill(); } catch {} }
}

/** Runs git clone. Resolves when it succeeded; rejects with a CloneError in plain words. spawnImpl is for tests. */
export function runClone({ url, dest, display, timeoutMs = CLONE_TIMEOUT_MS, spawnImpl = spawn, env = process.env }) {
  return new Promise((resolve, reject) => {
    const existed = fs.existsSync(dest);
    const cleanup = () => { if (!existed) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch {} } };
    let err = '';
    let done = false;
    let child;
    try {
      child = spawnImpl('git', gitArgs(url, dest), { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) { return reject(new CloneError(`Couldn't clone: ${String((e && e.message) || e).slice(0, 120)}`)); }
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      killTree(child);
      cleanup();
      finish(reject, new CloneError(`Couldn't clone: ${display} took longer than ${Math.round(timeoutMs / 60000)} minutes, so it was stopped`, 'timeout'));
    }, timeoutMs);
    child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
    child.once('error', (e) => {
      cleanup();
      finish(reject, new CloneError(e && e.code === 'ENOENT' ? "Couldn't clone: git is not installed on this PC" : `Couldn't clone: ${String((e && e.message) || e).slice(0, 120)}`, 'git'));
    });
    child.once('close', (code) => {
      if (code === 0) return finish(resolve);
      cleanup();
      const access = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|repository not found|access denied|403|401|not found|does not exist|publickey/i.test(err);
      finish(reject, new CloneError(access ? `Couldn't clone: no access to ${display}; check that this PC is signed in to git` : `Couldn't clone ${display}: ${err.split(/\r?\n/).filter(Boolean).pop()?.replace(/https?:\/\/\S+/g, '').trim().slice(0, 140) || 'git failed'}`, access ? 'access' : 'git'));
    });
  });
}

/** Turbo mode for one repo: refuse or resolve the address, find the destination, clone (unless the folder is already that repo). */
export async function prepareClone({ repo, cfg, run = runClone, remoteOf }) {
  if (cfg.allowClone === false) throw new CloneError("Couldn't clone: cloning is turned off on this PC", 'off');
  const { url, name, display } = cloneUrl(repo);
  const roots = cfg.roots || [];
  const { dest, reuse } = resolveDestination({ projectsDir: projectsDirOf(cfg), name, display, roots, ...(remoteOf ? { remoteOf } : {}) });
  if (!reuse) await run({ url, dest, display, ...(cfg.cloneTimeoutMs ? { timeoutMs: cfg.cloneTimeoutMs } : {}) });
  const dir = insideRoot(dest, roots);
  if (!dir) throw new CloneError("Couldn't clone: the new folder is outside the folders the worker scans");
  return { dir, reused: reuse, display };
}

const INTERIM_MS = 30_000;

/**
 * A start job with `clone: { repo }` and no folder. deps: { getConfig, state, save, api, launcher, scanAndReport, log, now }.
 * Result { id, ok, error?, folderId? }: the server links folderId to the project and shows the session in it.
 */
export async function handleCloneJob(job, deps) {
  const { getConfig, state, save, api, launcher, scanAndReport } = deps;
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());
  const id = typeof job.id === 'string' ? job.id : 'unknown';
  const fail = (e) => ({ id, ok: false, error: String((e && e.message) || e).slice(0, 300) });
  if (typeof job.sessionId !== 'string' || !UUID_RE.test(job.sessionId)) return fail('bad session id');
  if (job.prompt != null && (typeof job.prompt !== 'string' || job.prompt.length > MAX_PROMPT)) return fail('bad prompt');
  if (typeof job.projectId !== 'string' || typeof job.projectName !== 'string' || !job.clone || typeof job.clone.repo !== 'string') return fail('bad clone job');
  const prior = state.sessions[job.sessionId];
  if (prior) return { id, ok: true, ...(prior.folderId ? { folderId: prior.folderId } : {}) }; // re-offered: never a second window
  const progress = (phase) => api.postStatus({ sessions: [{ sessionId: job.sessionId, state: 'starting', phase }] }).catch(() => {});
  const beat = setInterval(() => progress('cloning'), INTERIM_MS);
  let dir;
  try {
    ({ dir } = await prepareClone({ repo: job.clone.repo, cfg: getConfig(), ...(deps.run ? { run: deps.run } : {}), ...(deps.remoteOf ? { remoteOf: deps.remoteOf } : {}) }));
  } catch (e) {
    return fail(e);
  } finally {
    clearInterval(beat);
  }
  try {
    await progress('starting');
    await scanAndReport(); // reports the new folder (name and git remote, never the path) and learns its folder id
    let real;
    try { real = fs.realpathSync(dir); } catch { real = dir; }
    const folderId = state.ids[real] || state.ids[dir];
    if (!folderId) return fail("Couldn't clone: the new folder was not found when scanning (is it deeper than the scan depth?)");
    writeMarker(dir, { projectId: job.projectId, projectName: job.projectName, folderId });
    state.markers[folderId] = true;
    trustFolder(dir, log);
    await launcher({ kind: 'start', folder: dir, sessionId: job.sessionId, projectName: job.projectName, prompt: getConfig().allowPrompts !== false ? job.prompt || undefined : undefined });
    state.sessions[job.sessionId] = { folderId, state: 'running', startedAt: now() };
    save();
    return { id, ok: true, folderId };
  } catch (e) {
    return fail(e);
  }
}
