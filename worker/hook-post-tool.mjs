// PostToolUse hook (mcp__.*__(save_state|import_state|get_state|end_work)): write WORK-STATE.md in the repo's main folder and commit
// that file alone. Skips builder worktrees, other projects, older versions, merges and rebases.
// Where the text comes from: an answer that still carries `markdown` (an old server or a protocol 1 session), else this hook
// fetches the copy itself, for the marker's project only: POST /api/agent/state with the session token (also sends Where
// after a save), or get_state copy:true with WORK_OS_KEY. Fails open: no token, no network or a refusal write nothing.
import os from 'node:os';
import { answerOf, copyState, markSaved, stateMarkdown } from './hook-copy.mjs';
import { git, mcpCall, postAgent, readKept, readMarker, repoFacts } from './hook-lib.mjs';

/** The copy (WORK-STATE.md text) of `project` from the server, or null. */
async function fetchCopy(input, cwd, project, saving) {
  const sid = input.session_id;
  const marker = sid ? readMarker(sid) : null;
  if (!marker?.project || marker.project !== project) return null; // only this repo's project
  let md = null;
  try {
    if (process.env.WORK_OS_KEY) {
      const text = await mcpCall('get_state', { project, copy: true });
      md = text ? JSON.parse(text).markdown : null;
    } else {
      const token = readKept(sid);
      if (!token) return null;
      const where = saving ? { machine: os.hostname().slice(0, 40), branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).slice(0, 120), ...repoFacts(cwd) } : null;
      const r = await postAgent('/api/agent/state', token, where ? { where } : {});
      md = r?.status === 200 ? r.b?.markdown : null;
    }
  } catch { return null; }
  return typeof md === 'string' && stateMarkdown(JSON.stringify({ markdown: md })) ? md : null;
}

/** PostToolUse on save_state / import_state / get_state / end_work: write WORK-STATE.md and commit that file alone. */
export async function postTool(input) {
  const cwd = input.cwd || process.cwd();
  const name = input.tool_name || '';
  // Lanes step 3: a session that does not hold Now (marker holdsNow === false) updates its lane with log_progress, set_doing, hand_in or
  // complete_task: that counts as Work OS having heard from it, so the Stop reminder does not ask again. Absent or true (the holder, and
  // every session until Lanes step 1 sets it) keeps the rule that only a State save counts. No copy is written for these.
  if (/__(log_progress|set_doing|hand_in|complete_task)$/.test(name)) {
    if (!answerOf(input.tool_response)?.error && !input.agent_id && readMarker(input.session_id)?.holdsNow === false) markSaved(input, cwd);
    return null;
  }
  const saving = /__(save_state|import_state|end_work)$/.test(name);
  const reading = /__get_state$/.test(name);
  const ans = answerOf(input.tool_response);
  const saved = saving && !!ans && (ans.saved === true || ans.ended === true || !!ans.imported);
  const marked = saved || (saving && !!stateMarkdown(input.tool_response));
  try {
    let md = stateMarkdown(input.tool_response);
    if (!md && ans && (saving || reading) && !ans.error && typeof ans.project === 'string') md = await fetchCopy(input, cwd, ans.project, saving);
    return copyState(input, cwd, md);
  } finally { if (marked) markSaved(input, cwd); }
}

export const handle = postTool;
