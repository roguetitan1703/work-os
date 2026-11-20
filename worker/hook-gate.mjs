// One gate for every Work OS hook (hook.mjs main runs it before any handler): it decides once, from the hook's input and the
// environment Claude Code gives its hooks, what kind of call this is, and RULES says what each hook does in each case. A hook
// file keeps no checks of its own for these cases.
//   sid        the Claude Code session (input.session_id); none: no hook does anything.
//   subagent   the call comes from a subagent (input.agent_id): it shares its parent's session id, so a hook that reports the
//              session's state (working, idle, waiting) would report the subagent's work as the parent's. Om, 21 Nov: a
//              background builder's Bash call after the lead's Stop marked the idle lead working and no message could wake it.
//   quiet      a `claude -p` or Agent SDK run (CLAUDE_CODE_ENTRYPOINT sdk-cli, sdk-ts, sdk-py: Claude Code sets sdk-cli for -p
//              itself): no person to brief, wake or ask. Such a run never registers (no token), so it is never on the roster.
//   parent     the claude process the session runs in (CLAUDE_PID, which Claude Code puts in its hooks' environment; else the
//              nearest claude ancestor, past any cmd or bash shim). Only the idle wait outlives a turn, so only it watches the
//              parent (gate.parentGone); every other hook runs while claude waits for it.
// The guards (pre-tool: WORK-STATE.md hand edits, production commands, a subagent's State writes) and the subagent hooks run in
// every case: they protect or serve exactly these calls.
import { claudeProcess, quietRun } from './hook-lib.mjs';

/**
 * What each hook does: 'run' or 'skip' for a subagent's call and for a -p / SDK run. These keep each hook's behaviour as it was
 * (a -p run has no token, so the skipped event hooks sent nothing before either), except tool-start for a subagent (21 Nov).
 * The hooks review (21 Nov) may change rows here: one table, one place.
 */
export const RULES = {
  'session-start': { subagent: 'skip', quiet: 'skip' }, // no brief, no registration, no token
  'user-prompt': { subagent: 'skip', quiet: 'skip' }, // a subagent's prompt is not the person's; no messages for a -p run
  'tool-batch': { subagent: 'skip', quiet: 'skip' },
  'tool-start': { subagent: 'skip', quiet: 'skip' },
  notification: { subagent: 'run', quiet: 'skip' }, // a subagent at a permission prompt: the session really waits for its person
  stop: { subagent: 'skip', quiet: 'run' }, // Stop is the main conversation's; a -p run that changed files is still asked to save State once
  wait: { subagent: 'skip', quiet: 'skip' }, // and it ends when the parent claude process is gone
  'session-end': { subagent: 'skip', quiet: 'skip' },
  'pre-tool': { subagent: 'run', quiet: 'run' }, // the guards
  'post-tool': { subagent: 'run', quiet: 'run' }, // the WORK-STATE.md copy; holdsNow is kept from the session's own answers only (hook-post-tool.mjs)
  'subagent-start': { subagent: 'run', quiet: 'run' },
  'subagent-stop': { subagent: 'run', quiet: 'run' },
};

/** The parent claude process: found once, checked by the wait (tests replace these). */
export const parent = {
  find: (env = process.env) => (/^\d{1,10}$/.test(env.CLAUDE_PID || '') && Number(env.CLAUDE_PID) > 0 ? { pid: Number(env.CLAUDE_PID) } : claudeProcess(env)),
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  everyMs: 2_000,
};

/**
 * The gate for one hook call: { run, why?, sid, subagent, quiet, parentGone() }. `run` false: the hook does nothing and prints
 * nothing. parentGone() looks the parent up on its first call only (unknown parent: never gone).
 */
export function gate(event, input) {
  const sid = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  const subagent = !!input?.agent_id;
  const quiet = quietRun();
  let owner;
  const parentGone = () => {
    if (owner === undefined) { try { owner = parent.find() ?? null; } catch { owner = null; } }
    return !!owner && !parent.alive(owner.pid);
  };
  const g = { sid, subagent, quiet, parentGone };
  const rule = RULES[event];
  if (!rule) return { ...g, run: true }; // an event with no row (main already refuses events outside EVENTS): no case applies
  // No session id: each hook already does nothing that needs one (the guards still run).
  if (subagent && rule.subagent === 'skip') return { ...g, run: false, why: 'subagent' };
  if (quiet && rule.quiet === 'skip') return { ...g, run: false, why: 'quiet run' };
  return { ...g, run: true };
}
