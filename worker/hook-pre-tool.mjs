// PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell, and the Work OS tools write_note, propose_order and
// apply_changes): refuse hand edits of WORK-STATE.md, naming save_state; refuse Orders edits from a dispatched run.
// One exception: an Edit that changes one line of the file is forwarded to the Work OS State (POST /api/agent/state, session
// token only), the file is then written from the answer, and the Edit is refused with "Applied to Work OS State vN". Write,
// MultiEdit, NotebookEdit and shell writes are only refused. No token, a timeout or any failure: the plain refusal.
import fs from 'node:fs';
import path from 'node:path';
import { COPY, COPY_REASON, markSaved, projectOf, writeCopy } from './hook-copy.mjs';
import { postAgent, postEvent, readKept, readMarker, run, workerHome } from './hook-lib.mjs';
import { loadConfig } from './config.mjs';
import { prodAction, releaseDeny } from './hook-release.mjs';

const COUNT_TIMEOUT_MS = 500; // H12: telling Work OS about a refusal that never reached it; the refusal never waits longer
const EDIT_TIMEOUT_MS = 3500; // the pre-tool hook is given 5 s (hook-lib.mjs EVENTS)
// PreToolUse runs before Claude Code's permission check, so an Edit is forwarded only when the session would let it through
// without asking: any other mode (default, plan, none given) gets the plain refusal and nothing is sent.
const FORWARD_MODES = new Set(['acceptEdits', 'bypassPermissions', 'auto']);

/**
 * The one-line change an Edit tool call would make to the copy: { old, new } as whole lines (new is '' to remove the line),
 * or null when it changes several lines, adds lines, matches more than once or cannot be read.
 */
export function oneLineChange(text, i) {
  text = text.replace(/\r\n/g, '\n');
  const o = String(i.old_string ?? '').replace(/\r\n/g, '\n');
  const n = String(i.new_string ?? '').replace(/\r\n/g, '\n');
  if (!o) return null;
  const at = text.indexOf(o);
  if (at < 0 || text.indexOf(o, at + 1) >= 0) return null;
  const a = text.split('\n');
  const b = (text.slice(0, at) + n + text.slice(at + o.length)).split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  if (ea - s !== 1 || eb - s > 1) return null;
  return { old: a[s], new: eb - s ? b[s] : '' };
}

/** Forwards an Edit of the copy to Work OS. Returns the hook's deny answer, or null for the plain refusal. */
async function forwardEdit(input, seen) {
  const sid = input.session_id;
  const i = input.tool_input || {};
  const token = sid ? readKept(sid) : null;
  const marker = sid ? readMarker(sid) : null;
  if (!FORWARD_MODES.has(input.permission_mode) || !token || !marker?.project || typeof i.file_path !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  const file = path.resolve(cwd, i.file_path);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (projectOf(text) !== marker.project) return null; // another project's copy
  const ch = oneLineChange(text, i);
  if (!ch) return null;
  let r;
  try { r = await postAgent('/api/agent/state', token, { edit: ch }, EDIT_TIMEOUT_MS); } catch { return null; }
  if (!r) return null;
  if (r.status === 200 || r.status === 400) seen.reached = true; // the server judged the edit and counted it (forwarded or refused); a 5xx or no answer did not
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  if (r.status === 400 && r.error) return deny('Work OS did not apply this edit: ' + r.error + ' ' + COPY_REASON);
  if (r.status !== 200 || typeof r.b?.markdown !== 'string') return null;
  let w = null;
  try { w = writeCopy(sid, path.dirname(file), r.b.markdown, { commit: false }); } catch {} // never git commit here: it can outlast the hook; the next post-tool commits
  try { markSaved(input, path.dirname(file)); } catch {}
  const v = r.b.version ?? r.b.applied?.version;
  const closed = r.b.applied?.closedTasks?.length ? ' Closed ' + r.b.applied.closedTasks.map((n) => '#' + n).join(', ') + '.' : '';
  const review = r.b.applied?.sentForReview?.length ? ' Sent for review: ' + r.b.applied.sentForReview.map((n) => '#' + n).join(', ') + '.' : '';
  return deny('Applied to Work OS State v' + v + '; ' + (w ? 'the file is updated (the next save commits it)' : 'the file was not written here (a builder worktree, another project or a merge under way)') + '.' + closed + review + ' Nothing more to do: do not repeat the edit.');
}

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
export async function preTool(input) {
  const od = ordersDeny(input);
  if (od) return od;
  const sd = shellDeny(input);
  if (sd) return sd;
  if (!hitsCopy(input)) {
    const blocked = await productionBlock(input);
    if (blocked) return blocked;
    await pingWorking(input);
    return null;
  }
  const seen = { reached: false };
  if (input.tool_name === 'Edit') {
    try { const f = await forwardEdit(input, seen); if (f) return f; } catch {}
  }
  // A plain refusal that never reached the server is counted here, once, with a short timeout (the answer does not wait on it).
  if (!seen.reached) await countRefused(input);
  return plainDeny();
}

/** A dispatched run: the worker's environment variable, or the server's mark in this session's marker (H15). The mark only adds refusals. */
export function isDispatched(input, env = process.env) {
  try {
    if (/^[0-9]{1,9}$/.test(String(env.WORK_OS_DISPATCHED || ''))) return true;
    const d = readMarker(input.session_id)?.dispatched;
    return Number.isInteger(d) && d > 0;
  } catch { return false; }
}

/**
 * A run the task dispatcher started (the worker sets WORK_OS_DISPATCHED=<task ref> in its environment, and the server marks the session in its start answer, kept in the
 * session marker as `dispatched`: either one counts, H15, so a run the worker resumed or that lost the variable stays refused) shares the person's key,
 * so the server cannot tell it from the person's own session by anything the run sends. It may not change an Orders page: the
 * brief's Orders note ids (kept in the session marker) are refused for write_note and apply_changes, and propose_order, which
 * always targets Orders, is refused outright. Fails closed only for those: no marker, no ids, any other note or tool passes.
 */
const ORDERS_TOOL = /^mcp__.+__(write_note|propose_order|apply_changes)$/;
export function ordersDeny(input, env = process.env) {
  try {
    if (!isDispatched(input, env)) return null;
    const m = ORDERS_TOOL.exec(String(input.tool_name || ''));
    if (!m) return null;
    const ids = new Set(Array.isArray(readMarker(input.session_id)?.orders) ? readMarker(input.session_id).orders : []);
    const tool = m[1];
    const hit = tool === 'propose_order' || (ids.size > 0 && JSON.stringify(input.tool_input ?? {}).match(/[A-Za-z0-9_-]{6,64}/g)?.some((w) => ids.has(w)));
    if (!hit) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Work OS: this run was started by the task dispatcher, and a dispatched run does not change Orders pages (' + tool + '). Say what you found in your report or with the feedback tool; the person edits Orders.' } };
  } catch { return null; }
}

/**
 * H15: the shell path for a dispatched run. A dispatched run shares the person's key, which sits on disk and in settings.json's env
 * block, so the Orders refusals above would mean little if the run could curl /api/mcp itself. A Bash or PowerShell command of a
 * dispatched run is refused when it names: WORK_OS_KEY (any form: $WORK_OS_KEY, $env:WORK_OS_KEY, printenv), a Work OS server's
 * /api/ paths (the worker's server, WORK_OS_URL, work.delpat.in), the Claude Code config file (.claude.json), the hooks' session
 * folder (hooks/sessions: the session tokens), a Claude settings.json together with an env read, or PowerShell's -EncodedCommand
 * (which hides what runs). This is a word detector, not a sandbox: on a PC the bypass can be made deliberate, not impossible (same
 * OS user). The reason says what to use instead. Fails open on any other error; nothing outside a dispatched run is touched.
 */
const USE_INSTEAD = 'Use the Work OS tools of this session (start_work, get_task, log_progress, ask, complete_task, end_work); a dispatched run does not call Work OS from a shell.';
const SHELL_RULES = [
  [/\bWORK_OS_KEY(?![A-Za-z0-9_])/i, 'the Work OS key'],
  [/\.claude\.json(?![A-Za-z0-9_-])/i, 'the Claude Code config file'],
  [/hooks[\\/]+sessions(?![A-Za-z0-9_-])/i, 'the hooks session folder'],
  [/(?:^|\s)-(?:encodedcommand|encodedcomman|encodedcomma|encodedcomm|encodedcom|encodedco|encodedc|encoded|encode|enc|ec)(?=[\s:=]|$)/i, 'an encoded PowerShell command'],
];
// "-e" and "-en" are PowerShell's own short forms of -EncodedCommand; they count only on a powershell or pwsh command line (grep -e is not it).
const PS_SHORT_ENC = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n|;&]*\s-(?:e|en)(?=\s)/i;
const SETTINGS_FILE = /\.claude[\\/]+settings(?:\.local)?\.json(?![A-Za-z0-9_-])/i;
function workOsHosts() {
  const hosts = new Set(['work.delpat.in']);
  const add = (u) => { try { if (u) hosts.add(new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).host.toLowerCase()); } catch {} };
  add(process.env.WORK_OS_URL);
  add(run.server);
  try { const h = workerHome(); if (h) add(loadConfig(h).baseUrl); } catch {}
  return [...hosts];
}
export function shellDeny(input, env = process.env) {
  try {
    const t = String(input.tool_name || '');
    if (!/^(Bash|PowerShell)$/.test(t)) return null;
    const cmd = (input.tool_input || {}).command;
    if (typeof cmd !== 'string' || !cmd) return null;
    if (!isDispatched(input, env)) return null;
    let what = null;
    for (const [re, name] of SHELL_RULES) if (re.test(cmd)) { what = name; break; }
    if (!what && PS_SHORT_ENC.test(cmd)) what = 'an encoded PowerShell command';
    if (!what && SETTINGS_FILE.test(cmd) && /\benv\b/i.test(cmd)) what = 'the env block of a Claude settings file';
    if (!what) {
      const lc = cmd.toLowerCase();
      for (const h of workOsHosts()) {
        for (let i = lc.indexOf(h); i >= 0; i = lc.indexOf(h, i + 1)) {
          if (/^\/+api(?:\/|$|[^a-z0-9_-])/.test(lc.slice(i + h.length).replace(/^:\d+/, ''))) what = 'the Work OS API';
        }
        if (what) break;
      }
    }
    if (!what) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Work OS: this run was started by the task dispatcher, and a dispatched run does not reach ' + what + ' from a shell command. ' + USE_INSTEAD } };
  } catch { return null; }
}

/** H12: one refused WORK-STATE.md write that never reached Work OS (a count, nothing else). Never throws and never waits long. */
async function countRefused(input) {
  try { if (input.session_id) await postEvent(input.session_id, 'tool', { copy: 'refused' }, COUNT_TIMEOUT_MS); } catch {}
}

const RELEASE_TIMEOUT_MS = 3000; // the route call; the hook as a whole has 5 s
/**
 * The production blocks (docs/flows/agent-system.md section 10): a Bash or PowerShell command that pushes, tags or releases to
 * the project's production, or runs a production CLI command, is refused unless the project's owner answered a release Need.
 * The hook decides locally whether the command is a production one (hook-release.mjs; the brief's `production` in the
 * marker) and asks Work OS only then, sending { what, name }, never the command. Fails closed on an exact match only: no
 * token, an unreachable, slow or refusing server all refuse; everything else (no marker, no production setting, a command
 * that is not an exact match) passes untouched. Returns the hook's deny answer or null.
 */
async function productionBlock(input) {
  try {
    const t = input.tool_name || '';
    const cmd = (input.tool_input || {}).command;
    const sid = input.session_id;
    if (!/^(Bash|PowerShell)$/.test(t) || typeof cmd !== 'string' || !sid) return null;
    if (!/\b(git|gh|vercel|netlify|supabase)\b/.test(cmd)) return null;
    const marker = readMarker(sid);
    if (!marker?.production) return null;
    const action = prodAction({ command: cmd, cwd: input.cwd }, marker.production);
    if (!action) return null;
    run.prod = action;
    const token = readKept(sid);
    if (!token) return releaseDeny(action, 'no-token', marker.project);
    let r = null;
    try { r = await postAgent('/api/agent/release', token, { what: action.what, name: action.name }, RELEASE_TIMEOUT_MS); } catch { r = null; }
    if (r?.status === 200 && r.b?.allowed === true) { run.prod = null; return null; }
    if (r?.status === 200 && r.b && r.b.allowed === false) return releaseDeny(action, r.b, marker.project);
    return releaseDeny(action, 'unconfirmed', marker.project);
  } catch {
    return null;
  }
}

const PING_EVERY_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 1000;
/**
 * Keeps Work OS's view of the session fresh: a tool call means working, so tell it once the marker says waiting (the prompt
 * was answered) or working but quiet for 5 minutes. Otherwise a local file read only. Never throws, never changes the answer.
 */
async function pingWorking(input) {
  try {
    const sid = input.session_id;
    const p = sid ? readMarker(sid)?.presence : null;
    if (!p) return;
    const fresh = Date.now() - (p.postedAt || 0) < PING_EVERY_MS;
    if ((p.state === 'waiting' && !(p.failed && fresh)) || (p.state === 'working' && !fresh)) await postEvent(sid, 'tool', {}, PING_TIMEOUT_MS);
  } catch {}
}

/** True when this tool call writes WORK-STATE.md. */
export function hitsCopy(input) {
  const t = input.tool_name || '';
  const i = input.tool_input || {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) return path.basename(String(i.file_path || i.notebook_path || '')).toUpperCase() === COPY.toUpperCase();
  if (/^(Bash|PowerShell)$/.test(t)) return writesCopy(String(i.command || ''));
  return false;
}

export const plainDeny = () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: COPY_REASON } });

/** For hook.mjs when the hook runs out of time: the plain refusal for a call that writes the copy, else nothing (fails closed for the copy only). */
export function timeoutAnswer(stdinText) {
  try {
    const input = JSON.parse(stdinText || '{}');
    if (hitsCopy(input)) return plainDeny();
    const od = ordersDeny(input);
    if (od) return od;
    const sd = shellDeny(input);
    if (sd) return sd;
    // A production action was found and Work OS had not answered yet: refuse (the hook cannot confirm a release Need in time).
    if (run.prod) return releaseDeny(run.prod, 'unconfirmed', readMarker(input.session_id)?.project);
    return null;
  } catch { return null; }
}

export const handle = preTool;
