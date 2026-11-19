// Shared parts of the Work OS Claude Code hooks (docs/HANDOVER.md "Claude Code hooks"). hook.mjs is the router; each event
// has its own file (hook-session-start.mjs, hook-stop.mjs, hook-pre-tool.mjs, hook-post-tool.mjs) and hook-copy.mjs holds
// the WORK-STATE.md copy. All files sit flat in worker/: the bundle, the loader and the installer read top-level *.mjs only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseUrl, loadConfig } from './config.mjs';
import { getToken } from './secret.mjs';

/** What the device-key path reads the key with; tests replace it (in process only, never from the environment). */
export const deps = { deviceKey: (dir) => getToken(dir) };
export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The worker config folder this copy was installed into (<dir>/hooks/hook.mjs), or null when it runs from elsewhere. */
export const workerHome = () => (path.basename(HERE) === 'hooks' && fs.existsSync(path.join(path.dirname(HERE), 'config.json')) ? path.dirname(HERE) : null);

/**
 * The events the hooks handle, one row each. hooks-install.mjs writes the settings entries from this table and hook.mjs
 * runs `hook-<event>.mjs` for a row and gives up 0.5 s before timeoutS. A new event is one file and one row.
 */
export const EVENTS = [
  // The brief (Orders, State, tasks) at start and after every compaction.
  { event: 'session-start', claudeEvent: 'SessionStart', matcher: 'startup|resume|clear|compact', timeoutS: 8 },
  // Files changed and State not saved: hold the session once and ask for save_state.
  { event: 'stop', claudeEvent: 'Stop', matcher: null, timeoutS: 8 },
  // Refuse hand edits of WORK-STATE.md (it is a copy of the Work OS State).
  { event: 'pre-tool', claudeEvent: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', timeoutS: 5 },
  // After a State save or read: write WORK-STATE.md from the answer and commit that file alone.
  { event: 'post-tool', claudeEvent: 'PostToolUse', matcher: 'mcp__.*__(save_state|import_state|get_state|end_work)', timeoutS: 20 },
];

export const SESSION_TOKEN_RE = /^wst_[A-Za-z0-9_-]{43}$/;
// Session tokens are kept beside the installed hook (<worker config dir>/hooks/sessions), never in the marker folder:
// WORK_OS_HOOK_DIR (and the temp folder) come from the environment, which a repo's settings could point into the repo.
// This folder is fixed by where the hook was installed: per user, outside every repo. Files older than two days are
// deleted on each write.
const tokenFile = (sid) => path.join(HERE, 'sessions', String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');
export const readKept = (sid) => { try { const k = JSON.parse(fs.readFileSync(tokenFile(sid), 'utf8')); return SESSION_TOKEN_RE.test(k.token) && k.until > Date.now() ? k.token : null; } catch { return null; } };
export function keepToken(sid, token, until) {
  const dir = path.dirname(tokenFile(sid));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile(sid), JSON.stringify({ token, until: until || Date.now() + 24 * 3600e3 }), { mode: 0o600 });
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86_400_000) fs.rmSync(p, { force: true }); } } catch {}
}

/** Set by hook.mjs from the command line: the server address a cloud repo's settings name (--server), used when WORK_OS_URL is not set. */
export const run = { server: null };

export const TIMEOUT_MS = 5000;
export const MAX_BRIEF = 9500; // Claude Code caps a hook context string at 10,000 characters
export const markerDir = () => process.env.WORK_OS_HOOK_DIR || path.join(os.tmpdir(), 'work-os-hooks');
const markerFile = (sid) => path.join(markerDir(), String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');

export const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
export const statusHash = (cwd) => createHash('sha1').update(git(cwd, ['status', '--porcelain'])).digest('hex');
export const readMarker = (sid) => { try { return JSON.parse(fs.readFileSync(markerFile(sid), 'utf8')); } catch { return null; } };
export const writeMarker = (sid, m) => { fs.mkdirSync(markerDir(), { recursive: true }); fs.writeFileSync(markerFile(sid), JSON.stringify(m)); };
export const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
export const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
export const cut = (s, n) => { s = str(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * Extra request headers every hook call sends. X-Work-OS-Hook is the hook protocol version: 2 = this hook fetches the copy
 * itself (get_state copy:true, POST /api/agent/state), so the server's save answers leave out the markdown. An old hook sends
 * nothing and is marked protocol 1 (it still gets the markdown in answers).
 */
export const HOOK_PROTOCOL = 2;
export const hookHeaders = () => ({ 'x-work-os-hook': String(HOOK_PROTOCOL) });

/**
 * What git says about a folder, for Where: { head, dirty, worktrees }. head is the short commit, dirty whether the working
 * tree has changes, worktrees "path [branch]" for each (at most 20, 200 characters each). Empty parts are left out.
 */
export function repoFacts(cwd) {
  const out = {};
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (head) {
    out.head = head.slice(0, 80);
    out.dirty = git(cwd, ['status', '--porcelain']) !== '';
  }
  const list = [];
  for (const block of git(cwd, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const p = lines.find((l) => l.startsWith('worktree '))?.slice(9).trim();
    if (!p) continue;
    const b = lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || (lines.includes('detached') ? 'detached' : '');
    list.push((b ? `${p} [${b}]` : p).slice(0, 200));
  }
  if (list.length) out.worktrees = list.slice(0, 20);
  return out;
}

export async function mcpCall(name, args) {
  const key = process.env.WORK_OS_KEY || '';
  if (!/^wos_[A-Za-z0-9_-]{8,}$/.test(key)) return null;
  const base = checkBaseUrl(process.env.WORK_OS_URL || run.server || loadConfig().baseUrl);
  const res = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...hookHeaders() },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const t = await res.text();
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  if (b.error || b.result?.isError) return null;
  const text = b.result?.content?.[0]?.text;
  return typeof text === 'string' ? text : null;
}

/**
 * POST to the Work OS server of the worker config this copy was installed beside, with `cred` (a device key or a session
 * token). Returns { status, b } (b is the JSON answer on 200, else null), or null when this copy is not installed. Never
 * follows a redirect, so the credential cannot be sent to another address.
 */
export async function postAgent(apiPath, cred, body, timeoutMs = TIMEOUT_MS) {
  const home = workerHome();
  if (!home) return null;
  const base = checkBaseUrl(loadConfig(home).baseUrl);
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}`, ...hookHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  let b = null;
  try { b = await res.json(); } catch {}
  return { status: res.status, b: res.ok ? b : null, error: !res.ok && typeof b?.error === 'string' ? b.error : null };
}
