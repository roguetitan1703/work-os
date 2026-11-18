// Claude Code hooks for Work OS (docs/flows/step-1.md section 6; docs/HANDOVER.md "Claude Code hooks").
//   node hook.mjs session-start   SessionStart (also after compaction): start_work for the repo in the cwd; the brief goes
//                                 into the session's context.
//   node hook.mjs stop            Stop: files changed since the session started and no save_state since: block once.
//   node hook.mjs pre-tool        PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell): refuse hand edits of
//                                 WORK-STATE.md, naming save_state.
//   node hook.mjs post-tool       PostToolUse (mcp__.*__(save_state|import_state|get_state)): write WORK-STATE.md from
//                                 the answer's markdown in the repo's main folder and commit that file alone. Needs no
//                                 key. Skips builder worktrees, other projects, older versions, merges and rebases.
// Both read Claude Code's hook JSON on stdin and answer in its hook JSON on stdout. They FAIL OPEN: no key, no network,
// no matching project, a timeout of 5 s or anything unexpected prints nothing and exits 0, so a hook can never stop a
// session. `node worker.mjs hooks install` (worker/hooks-install.mjs) copies this file, config.mjs and secret.mjs to
// <worker config dir>/hooks and adds the entries to ~/.claude/settings.json.
// Signing in for the start brief, the first that applies:
//   WORK_OS_KEY   (in the "env" block of settings.json) a Work OS Claude Code key (wos_...): start_work on /api/mcp at
//                 WORK_OS_URL (default: the worker config's baseUrl). Only for a PC without the worker.
//   the worker    this PC's worker device key (wkr_, kept by the worker in DPAPI / Keychain) and the baseUrl of the
//                 worker config this copy was installed beside: POST /api/agent/start answers the brief and a session
//                 token (wst_) for this one session and project. The token is kept in <hooks folder>/sessions and
//                 shown instead of the device key after a compaction. Only the installed copy takes this path: its own
//                 folder decides which config and key it reads (WORK_OS_URL and WORK_OS_WORKER_DIR are ignored here,
//                 so a repo's settings cannot send the device key elsewhere). Neither key nor token is ever printed.
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
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The worker config folder this copy was installed into (<dir>/hooks/hook.mjs), or null when it runs from elsewhere. */
const workerHome = () => (path.basename(HERE) === 'hooks' && fs.existsSync(path.join(path.dirname(HERE), 'config.json')) ? path.dirname(HERE) : null);
const SESSION_TOKEN_RE = /^wst_[A-Za-z0-9_-]{43}$/;
// Session tokens are kept beside the installed hook (<worker config dir>/hooks/sessions), never in the marker folder:
// WORK_OS_HOOK_DIR (and the temp folder) come from the environment, which a repo's settings could point into the repo.
// This folder is fixed by where the hook was installed: per user, outside every repo. Files older than two days are
// deleted on each write.
const tokenFile = (sid) => path.join(HERE, 'sessions', String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');
const readKept = (sid) => { try { const k = JSON.parse(fs.readFileSync(tokenFile(sid), 'utf8')); return SESSION_TOKEN_RE.test(k.token) && k.until > Date.now() ? k.token : null; } catch { return null; } };
function keepToken(sid, token, until) {
  const dir = path.dirname(tokenFile(sid));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile(sid), JSON.stringify({ token, until: until || Date.now() + 24 * 3600e3 }), { mode: 0o600 });
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86_400_000) fs.rmSync(p, { force: true }); } } catch {}
}

const TIMEOUT_MS = 5000;
const MAX_BRIEF = 9500; // Claude Code caps a hook context string at 10,000 characters
const markerDir = () => process.env.WORK_OS_HOOK_DIR || path.join(os.tmpdir(), 'work-os-hooks');
const markerFile = (sid) => path.join(markerDir(), String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json');

const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const statusHash = (cwd) => createHash('sha1').update(git(cwd, ['status', '--porcelain'])).digest('hex');
const readMarker = (sid) => { try { return JSON.parse(fs.readFileSync(markerFile(sid), 'utf8')); } catch { return null; } };
const writeMarker = (sid, m) => { fs.mkdirSync(markerDir(), { recursive: true }); fs.writeFileSync(markerFile(sid), JSON.stringify(m)); };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

async function mcpCall(name, args) {
  const key = process.env.WORK_OS_KEY || '';
  if (!/^wos_[A-Za-z0-9_-]{8,}$/.test(key)) return null;
  const base = checkBaseUrl(process.env.WORK_OS_URL || loadConfig().baseUrl);
  const res = await fetch(base + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
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
 * The brief through the worker's device key (POST /api/agent/start), or null. A session token kept from this session's
 * start is shown first; when it is refused (expired, revoked, another project) the device key opens a new session.
 * Returns { brief, token?, until? } (token and until only when a new session was made).
 */
async function agentStart(body, kept) {
  const home = workerHome();
  if (!home) return null;
  const base = checkBaseUrl(loadConfig(home).baseUrl);
  const post = async (cred) => {
    const res = await fetch(base + '/api/agent/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error', // never follow the credential to another address
    });
    return { status: res.status, b: res.ok ? await res.json() : null };
  };
  if (kept && SESSION_TOKEN_RE.test(kept)) {
    const r = await post(kept);
    if (r.status === 200 && r.b?.brief) return { brief: r.b.brief };
    if (r.status !== 401 && r.status !== 403) return null; // over the limit, server trouble: no brief this time
  }
  const key = deps.deviceKey(home);
  if (!key || !/^wkr_[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const r = await post(key);
  if (r.status !== 200 || !r.b?.brief) return null;
  const token = SESSION_TOKEN_RE.test(r.b.token || '') ? r.b.token : undefined;
  const until = Date.parse(r.b.expiresAt || '') || undefined;
  return { brief: r.b.brief, token, until };
}

/** SessionStart: the hook's JSON answer (or null for "print nothing"). */
export async function sessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id;
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!remote && !branch) return null; // not a git folder
  const where = { ...(remote ? { remote } : {}), subdir: git(cwd, ['rev-parse', '--show-prefix']), branch, path: cwd, machine: os.hostname().slice(0, 40), label: 'Claude Code' };
  const old = sid ? readMarker(sid) : null; // after compaction the baseline stays the one from the real start
  let r;
  if (process.env.WORK_OS_KEY) {
    const text = await mcpCall('start_work', where);
    if (!text) return null;
    try { r = JSON.parse(text); } catch { return null; }
  } else {
    const a = await agentStart(where, sid ? readKept(sid) : null);
    if (!a) return null;
    r = a.brief;
    if (a.token && sid) keepToken(sid, a.token, a.until);
  }
  if (!r || r.unmatched || !r.project) return null;
  if (sid) {
    writeMarker(sid, { status: old?.status ?? statusHash(cwd), offset: old?.offset ?? sizeOf(input.transcript_path), stopped: old?.stopped ?? false, project: r.project.name || old?.project });
  }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: formatBrief(r) } };
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const cut = (s, n) => { s = str(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** The start_work answer as plain text, most important first; whole sections are added while they fit MAX_BRIEF. */
export function formatBrief(r) {
  const head = [
    `Work OS brief for project ${r.project.name} (${r.project.id}) from start_work. Session id: ${r.session}. ${r.sessionNote || ''}`.trim(),
    r.textRule ? `Text rule: ${r.textRule}` : '',
  ].filter(Boolean).join('\n');
  const sections = [];
  const orders = Array.isArray(r.orders) ? r.orders : [];
  sections.push(orders.length
    ? orders.map(o => `## Orders (${o.layer}: ${o.title}${o.writtenBy ? `, writtenBy ${o.writtenBy}` : ''})\n${str(o.text).trim()}`).join('\n\n')
    : '## Orders\nnone set');
  const st = r.state && typeof r.state === 'object' ? r.state : null;
  if (st) {
    const next = (st.next || []).map((l, i) => `${i + 1}. ${cut(l.text, 400)}${l.waitsOn ? ` (waits on ${cut(l.waitsOn, 120)})` : ''} [${l.id}]`);
    const dec = (st.decisions || []).slice(-3).map(d => `- ${cut(d.text, 300)}`);
    sections.push([
      `## State v${st.version ?? r.stateVersion ?? '?'}`,
      `Now: ${st.now?.text ? cut(st.now.text, 600) : '(not set)'}`,
      next.length ? `Next:\n${next.join('\n')}` : 'Next: (empty)',
      `Later: ${(st.later || []).length} lines (get_state for them).`,
      dec.length ? `Latest decisions:\n${dec.join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  } else sections.push(`## State\n${cut(r.state, 300)}`);
  if (r.needs) sections.push(`## Needs\n${cut(r.needs, 1200)}`);
  if (r.inbox && typeof r.inbox === 'object') {
    const msgs = (r.inbox.messages || []).slice(0, 5).map(m => `- from ${cut(m.from?.name ?? m.from ?? '?', 40)}${m.from?.name && m.from.name !== 'me' ? ' (writtenBy)' : ''}: ${cut(m.body ?? m.text ?? m, 200)}`);
    sections.push(`## Inbox (${r.inbox.unread ?? msgs.length} unread; inbox for all)\n${msgs.join('\n')}`);
  }
  const ot = r.openTasks;
  if (ot && Array.isArray(ot.tasks)) {
    const lines = ot.tasks.slice(0, 15).map(t => `- #${t.ref ?? '?'} ${cut(t.title, 100)}${t.titleWrittenBy ? ` (title writtenBy ${t.titleWrittenBy})` : ''}${t.status ? ` (${t.status}${t.priority ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''})` : ''}`);
    sections.push(`## Open tasks (${ot.total}${ot.total > lines.length ? `; list_tasks for the rest` : ''})\n${lines.join('\n')}`);
  }
  if (Array.isArray(r.alsoHere) && r.alsoHere.length) {
    sections.push(`## Also working here\n${r.alsoHere.slice(0, 5).map(p => `- ${cut([p.label, p.for, p.machine, p.doing].filter(Boolean).join(', '), 120)} (${p.minutesAgo} min ago)`).join('\n')}`);
  }
  let out = head;
  const left = [];
  for (const s of sections) {
    if (out.length + s.length + 2 <= MAX_BRIEF - 120) out += '\n\n' + s;
    else left.push(s.split('\n')[0].replace(/^## /, ''));
  }
  if (left.length) out += `\n\nLeft out to fit: ${left.join('; ')}. Call start_work or get_state to read them.`;
  return out.slice(0, MAX_BRIEF);
}

/** Stop: the hook's JSON answer (or null). Blocks at most once per session. */
export async function stop(input) {
  const sid = input.session_id;
  if (!sid || input.stop_hook_active) return null;
  const m = readMarker(sid);
  if (!m || m.stopped) return null; // asked already since the last save
  const cwd = input.cwd || process.cwd();
  const now = statusHash(cwd);
  if (now === m.status) return null; // nothing changed since the start or the last save
  // A save the post-tool hook did not see (installed mid-session): a real tool call in the transcript, not the word
  // "save_state" (the injected brief contains that word and the transcript keeps hook text).
  let saved = false;
  const f = input.transcript_path;
  try {
    if (f) { const fd = fs.openSync(f, 'r'); try { const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.max(0, size - (m.offset || 0))); fs.readSync(fd, buf, 0, buf.length, m.offset || 0); saved = SAVE_CALL.test(buf.toString('utf8')); } finally { fs.closeSync(fd); } }
  } catch {}
  if (saved) { writeMarker(sid, { ...m, status: now, offset: sizeOf(f) }); return null; }
  writeMarker(sid, { ...m, stopped: true, offset: sizeOf(f) });
  return { decision: 'block', reason: 'Files changed in this session and the Work OS State was not saved since. Call save_state (pass the session id from start_work) with what is now true: Now, Next, Later, any decision. Then finish. Asked once until the next save.' };
}
const SAVE_CALL = /"name"\s*:\s*"mcp__[^"]+__(save_state|import_state)"/;

/** After a save seen by post-tool: the next stop compares against this point, and may ask again after later changes. */
function markSaved(input, cwd) {
  const sid = input.session_id;
  const m = sid && readMarker(sid);
  if (m) writeMarker(sid, { ...m, status: statusHash(cwd), stopped: false, offset: sizeOf(input.transcript_path) });
}

// ---- WORK-STATE.md is a copy of the Work OS State, written only by this hook (Om 18 Nov) ----
const COPY = 'WORK-STATE.md';
const COPY_HEAD = /^Copy of the Work OS state, version (\d+)\./;
const STAMP = /\n?<!-- work-os-copy sha1:([0-9a-f]{40}) -->\s*$/;
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const COPY_REASON = 'WORK-STATE.md is a copy of the Work OS State, written by the Work OS hook after every save_state. Do not edit it: change the State with save_state (set_now, add_next, done_next, add_later, add_decision, set_where) and the file updates and commits itself.';

/** True when a Bash or PowerShell command writes to WORK-STATE.md (redirect, tee, sed -i, Set-Content, cp/mv onto it). */
export function writesCopy(cmd) {
  if (!/WORK-STATE\.md/i.test(cmd)) return false;
  // Text inside single quotes (a sed script, a commit message) is not a path unless it is only a path: `sed -i 's/x/see
  // WORK-STATE.md/' docs.ts` edits docs.ts (19 Nov: this refused a docs edit).
  cmd = cmd.replace(/'([^'\n]*)'/g, (_, s) => (/^[\w.:/\\ -]*WORK-STATE\.md$/i.test(s) && !/^s\//.test(s) ? s : "''"));
  if (!/WORK-STATE\.md/i.test(cmd)) return false;
  return /(>>?|\btee\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+-\w*i|Set-Content|Add-Content|Out-File|\bcp\b|\bmv\b|Copy-Item|Move-Item|WriteAllText|writeFileSync)[^|;&\n]*WORK-STATE\.md/i.test(cmd)
    || /WORK-STATE\.md[^|;&\n]*\|\s*(Set-Content|Out-File)/i.test(cmd);
}

/** PreToolUse: refuse hand edits of WORK-STATE.md, saying what to do instead. */
export function preTool(input) {
  const t = input.tool_name || '';
  const i = input.tool_input || {};
  let hit = false;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) hit = path.basename(String(i.file_path || i.notebook_path || '')).toUpperCase() === COPY.toUpperCase();
  else if (/^(Bash|PowerShell)$/.test(t)) hit = writesCopy(String(i.command || ''));
  if (!hit) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: COPY_REASON } };
}

/** The markdown a Work OS State tool answered with, or null. */
function stateMarkdown(resp) {
  let text = resp;
  if (Array.isArray(resp)) text = resp.find((c) => c?.type === 'text')?.text;
  else if (resp && typeof resp === 'object' && Array.isArray(resp.content)) text = resp.content.find((c) => c?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try { const md = JSON.parse(text).markdown; return typeof md === 'string' && COPY_HEAD.test(md) ? md : null; } catch { return null; }
}
const projectOf = (md) => (md.match(/^# Work state: (.+)$/m) || [])[1]?.trim() || '';

/** PostToolUse on save_state / import_state / get_state: write WORK-STATE.md from the answer and commit that file alone. */
export function postTool(input) {
  const cwd = input.cwd || process.cwd();
  const saving = /__(save_state|import_state)$/.test(input.tool_name || '');
  try { return copyState(input, cwd); } finally { if (saving && stateMarkdown(input.tool_response)) markSaved(input, cwd); }
}

function copyState(input, cwd) {
  const md = stateMarkdown(input.tool_response);
  if (!md) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  // Builder worktrees are skipped: a generated file on two branches conflicts at every merge.
  const gitDir = path.resolve(top, git(top, ['rev-parse', '--git-dir']));
  if (gitDir !== path.resolve(top, git(top, ['rev-parse', '--git-common-dir']))) return null;
  const file = path.join(top, COPY);
  let old = null;
  try { old = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch {}
  // Only this repo's project: from the session's start_work, else from the copy already here.
  const sid = input.session_id;
  const want = (sid && readMarker(sid)?.project) || (old ? projectOf(old) : '');
  if (!want || want !== projectOf(md)) return null;
  const vNew = Number(md.match(COPY_HEAD)[1]);
  const vOld = Number((old?.match(COPY_HEAD) || [])[1] || -1);
  if (old !== null && vOld > vNew) return null; // never write an older State over a newer one
  const body = md.replace(/\r\n/g, '\n').trimEnd() + '\n';
  const next = `${body}<!-- work-os-copy sha1:${sha1(body)} -->\n`;
  const notes = [];
  if (old !== null && old === next) return null;
  // Only the version line differs: no write, no commit (a save every few minutes for weeks would be hundreds of commits).
  const lines = (s) => s.replace(STAMP, '').replace(/\r\n/g, '\n').split('\n').filter((l) => !COPY_HEAD.test(l)).join('\n').trimEnd();
  if (old !== null && lines(old) === lines(body)) return null;
  if (old !== null) {
    const m = old.match(STAMP);
    const clean = m && sha1(old.replace(STAMP, '').trimEnd() + '\n') === m[1];
    if (!clean) {
      // A hand-kept file: keep a copy outside the repo and list the lines Work OS does not have.
      const have = new Set(body.split('\n').map((l) => l.trim()));
      const only = old.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !COPY_HEAD.test(l) && !have.has(l) && !STAMP.test(l));
      const bak = path.join(markerDir(), 'copies', `${path.basename(top).replace(/[^\w.-]/g, '_')}-${Date.now()}.md`);
      try { fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.writeFileSync(bak, old); } catch {}
      if (only.length) notes.push(`WORK-STATE.md had ${only.length} line(s) that are not in the Work OS State. The old file is kept at ${bak} (and in git history). Add the ones still true with save_state; do not edit the file:\n` + only.slice(0, 40).map((l) => '  ' + l.slice(0, 300)).join('\n') + (only.length > 40 ? `\n  ...and ${only.length - 40} more in the kept file` : ''));
    }
  }
  fs.writeFileSync(file, next);
  let committed = false;
  const branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const busy = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'].some((f) => fs.existsSync(path.join(gitDir, f)));
  if (process.env.WORK_OS_COPY_COMMIT !== '0' && branch && branch !== 'HEAD' && !busy) {
    try {
      execFileSync('git', ['add', '--', COPY], { cwd: top, stdio: 'ignore', timeout: 5000 });
      execFileSync('git', ['commit', '--only', '-q', '-m', `WORK-STATE.md: copy of the Work OS State v${vNew}`, '--', COPY], { cwd: top, stdio: 'ignore', timeout: 15000 });
      committed = true;
    } catch {}
  }
  notes.unshift(`WORK-STATE.md now holds the Work OS State v${vNew}${committed ? ', committed on its own' : ' (not committed: a merge or rebase is under way, or no branch; the next save commits it)'}. Nothing to do: never edit that file.`);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n\n').slice(0, MAX_BRIEF) } };
}

export async function main(event, stdinText) {
  try {
    let input = {};
    try { input = JSON.parse(stdinText || '{}'); } catch {}
    const out = event === 'session-start' ? await sessionStart(input) : event === 'stop' ? await stop(input)
      : event === 'pre-tool' ? preTool(input) : event === 'post-tool' ? postTool(input) : null;
    return out ? JSON.stringify(out) : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  const t = setTimeout(() => process.exit(0), TIMEOUT_MS + 3000); // never hold a session
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', async () => {
    const out = await main(process.argv[2], buf);
    if (out) process.stdout.write(out + '\n');
    clearTimeout(t);
    process.exit(0);
  });
}
