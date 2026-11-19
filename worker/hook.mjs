// Claude Code hooks for Work OS (docs/flows/step-1.md section 6; docs/HANDOVER.md "Claude Code hooks"). This file is the
// entry point and the router: `node hook.mjs <event>` runs hook-<event>.mjs, for the events listed in EVENTS (hook-lib.mjs).
//   session-start  SessionStart (also after compaction): start_work for the repo in the cwd; the brief goes into context.
//   stop           Stop: files changed since the session started and no save_state (or end_work) since: block once.
//   pre-tool       PreToolUse: refuse hand edits of WORK-STATE.md, naming save_state.
//   post-tool      PostToolUse (save_state|import_state|get_state|end_work): write WORK-STATE.md from the answer's markdown and
//                  commit that file alone.
//   user-prompt    UserPromptSubmit: tell Work OS the session is working; a message waiting for the session goes into its context.
//   tool-batch     PostToolBatch: at most every 20 s, tell Work OS it is still working and hand over a message waiting for it.
//   wait           Stop and SessionStart (asyncRewake): the idle session's long poll on /api/agent/wait; a message that may wake the
//                  session ends it with exit code 2 and the framed text on stderr, which wakes the session.
//   notification   Notification (permission_prompt|idle_prompt|elicitation_dialog, async): waiting at a prompt, or idle. No output.
//   session-end    SessionEnd: tell Work OS the session is off. No output.
//   subagent-start SubagentStart: the short form of the organization Orders (from the session's marker, no network) as context.
//                  These and the stop and pre-tool pings use POST /api/agent/event with the session token (postEvent in
//                  hook-lib.mjs); no token (WORK_OS_KEY, cloud) sends nothing, and a failure is silent.
//   Flags: --cloud (do nothing unless CLAUDE_CODE_REMOTE=true), --server <url> and --project <id> (the project a cloud repo's
//   sessions start on; the key path then calls start_work { project }), written by `hooks repo`.
// Each reads Claude Code's hook JSON on stdin and answers in its hook JSON on stdout. They FAIL OPEN: no key, no network,
// no matching project, a timeout or anything unexpected prints nothing and exits 0, so a hook can never stop a session.
// `node worker.mjs hooks install` (worker/hooks-install.mjs) copies this file and the files it needs (FILES there) to
// <worker config dir>/hooks and adds the entries to ~/.claude/settings.json. How the start brief signs in: see
// hook-session-start.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, run } from './hook-lib.mjs';
import { timeoutAnswer } from './hook-pre-tool.mjs';

// What tests and flows import from here.
export { deps } from './hook-lib.mjs';
export { sessionStart, formatBrief } from './hook-session-start.mjs';
export { stop } from './hook-stop.mjs';
export { preTool, writesCopy } from './hook-pre-tool.mjs';
export { postTool } from './hook-post-tool.mjs';

/**
 * Runs the event's handler and awaits it (sync or async). Returns the JSON text to print, or '' for nothing.
 * `cloud` (the --cloud flag of a repo's settings, see hooks-install.mjs "repo"): do nothing unless this is a Claude Code
 * cloud session (CLAUDE_CODE_REMOTE=true), so a repo's hooks stay silent on a PC, where the global hooks run.
 * `server` (--server): the Work OS address when WORK_OS_URL is not set.
 * `project` (--project): the project id a cloud repo's sessions start on (hooks-install.mjs "repo").
 */
export async function main(event, stdinText, { cloud = false, server = null, project = null } = {}) {
  try {
    if (!EVENTS.some((e) => e.event === event)) return '';
    if (cloud && process.env.CLAUDE_CODE_REMOTE !== 'true') return '';
    run.server = server;
    run.project = project;
    let input = {};
    try { input = JSON.parse(stdinText || '{}'); } catch {}
    const out = await (await import(`./hook-${event}.mjs`)).handle(input);
    return out ? JSON.stringify(out) : '';
  } catch {
    return '';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const row = EVENTS.find((e) => e.event === process.argv[2]);
  if (!row) process.exit(0);
  const flags = process.argv.slice(3);
  const opts = { cloud: flags.includes('--cloud'), server: flags.includes('--server') ? flags[flags.indexOf('--server') + 1] || null : null, project: flags.includes('--project') ? flags[flags.indexOf('--project') + 1] || null : null };
  if (opts.cloud && process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);
  let buf = '';
  process.stdin.setEncoding('utf8');
  const t = setTimeout(() => {
    // Never hold a session. Out of time in pre-tool: refuse a write of the copy (as the plain refusal) rather than let it through.
    const late = row.event === 'pre-tool' ? timeoutAnswer(buf) : null;
    if (late) process.stdout.write(JSON.stringify(late) + '\n', () => process.exit(0));
    else process.exit(0);
  }, row.timeoutS * 1000 - 500);
  process.stdin.on('end', async () => {
    const out = await main(row.event, buf, opts);
    if (out) process.stdout.write(out + '\n');
    clearTimeout(t);
    // The idle wait ends with exit 2 and the text on stderr to wake the session; every other hook ends 0.
    if (run.stderr) process.stderr.write(run.stderr + '\n', () => process.exit(run.exitCode || 0));
    else process.exit(run.exitCode || 0);
  });
  process.stdin.on('data', (d) => (buf += d));
}
