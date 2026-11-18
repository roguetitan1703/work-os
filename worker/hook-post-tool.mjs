// PostToolUse hook (mcp__.*__(save_state|import_state|get_state)): write WORK-STATE.md from the answer's markdown in the
// repo's main folder and commit that file alone. Needs no key. Skips builder worktrees, other projects, older versions,
// merges and rebases.
import { copyState, markSaved, stateMarkdown } from './hook-copy.mjs';

/** PostToolUse on save_state / import_state / get_state: write WORK-STATE.md from the answer and commit that file alone. */
export function postTool(input) {
  const cwd = input.cwd || process.cwd();
  const saving = /__(save_state|import_state)$/.test(input.tool_name || '');
  try { return copyState(input, cwd); } finally { if (saving && stateMarkdown(input.tool_response)) markSaved(input, cwd); }
}

export const handle = postTool;
