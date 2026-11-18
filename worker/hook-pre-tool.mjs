// PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell): refuse hand edits of WORK-STATE.md, naming save_state.
import path from 'node:path';
import { COPY, COPY_REASON } from './hook-copy.mjs';

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

export const handle = preTool;
