// PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell): refuse hand edits of WORK-STATE.md, naming save_state.
// One exception: an Edit that changes one line of the file is forwarded to the Work OS State (POST /api/agent/state, session
// token only), the file is then written from the answer, and the Edit is refused with "Applied to Work OS State vN". Write,
// MultiEdit, NotebookEdit and shell writes are only refused. No token, a timeout or any failure: the plain refusal.
import fs from 'node:fs';
import path from 'node:path';
import { COPY, COPY_REASON, markSaved, projectOf, writeCopy } from './hook-copy.mjs';
import { postAgent, readKept, readMarker } from './hook-lib.mjs';

const EDIT_TIMEOUT_MS = 3500; // the pre-tool hook is given 5 s (hook-lib.mjs EVENTS)

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
async function forwardEdit(input) {
  const sid = input.session_id;
  const i = input.tool_input || {};
  const token = sid ? readKept(sid) : null;
  const marker = sid ? readMarker(sid) : null;
  if (!token || !marker?.project || typeof i.file_path !== 'string') return null;
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
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  if (r.status === 400 && r.error) return deny('Work OS did not apply this edit: ' + r.error + ' ' + COPY_REASON);
  if (r.status !== 200 || typeof r.b?.markdown !== 'string') return null;
  let w = null;
  try { w = writeCopy(sid, path.dirname(file), r.b.markdown); } catch {}
  try { markSaved(input, path.dirname(file)); } catch {}
  const v = r.b.version ?? r.b.applied?.version;
  const closed = r.b.applied?.closedTasks?.length ? ' Closed ' + r.b.applied.closedTasks.map((n) => '#' + n).join(', ') + '.' : '';
  const review = r.b.applied?.sentForReview?.length ? ' Sent for review: ' + r.b.applied.sentForReview.map((n) => '#' + n).join(', ') + '.' : '';
  return deny('Applied to Work OS State v' + v + '; ' + (w ? 'the file is updated' + (w.committed ? ' and committed' : '') : 'the file was not written here (a builder worktree, another project or a merge under way)') + '.' + closed + review + ' Nothing more to do: do not repeat the edit.');
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
  const t = input.tool_name || '';
  const i = input.tool_input || {};
  let hit = false;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) hit = path.basename(String(i.file_path || i.notebook_path || '')).toUpperCase() === COPY.toUpperCase();
  else if (/^(Bash|PowerShell)$/.test(t)) hit = writesCopy(String(i.command || ''));
  if (!hit) return null;
  if (t === 'Edit') {
    try { const f = await forwardEdit(input); if (f) return f; } catch {}
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: COPY_REASON } };
}

export const handle = preTool;
