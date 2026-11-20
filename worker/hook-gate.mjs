// One gate for every Work OS hook (hook.mjs main runs it before any handler; hooks review 21 Nov, section 3): it decides once,
// from the hook's input and the environment Claude Code gives its hooks, what kind of call this is, and RULES says what each
// hook does in each case. A hook file keeps no checks of its own for these cases.
//   sid         the Claude Code session (input.session_id).
//   subagent    the call comes from a subagent (input.agent_id): it shares its parent's session id, so a hook that reports the
//               session's state (working, idle, waiting) would report the subagent's work as the parent's. Om, 21 Nov: a
//               background builder's Bash call after the lead's Stop marked the idle lead working and no message could wake it.
//   quiet       a `claude -p` or Agent SDK run (CLAUDE_CODE_ENTRYPOINT sdk-cli, sdk-ts, sdk-py: Claude Code sets sdk-cli for -p
//               itself): no person to brief, wake or ask. It never registers, posts nothing and never waits.
//   dispatched  a run the task dispatcher started (WORK_OS_DISPATCHED, set by the worker): it reports its state like any session,
//               but never waits and is never woken (Om's default, 21 Nov): it works its task and stops.
//   parent      the claude process the session runs in: CLAUDE_PID (Claude Code puts it in its hooks' environment), checked against
//               the start time the session-start hook kept in <hooks>/sessions/<id>.proc, so a pid another process took later
//               does not count; else the nearest claude ancestor. Only the idle wait outlives a turn, so only it watches the parent.
// The guards (pre-tool: WORK-STATE.md hand edits, production commands, a subagent's State writes) run in every case: they protect
// exactly these calls. pre-tool's own presence ping follows the subagent rule inside pre-tool (g.reports).
import fs from 'node:fs';
import path from 'node:path';
import { HERE, claudeProcess, processFacts } from './hook-lib.mjs';

/** What each hook does for a subagent's call, a -p / SDK run and a dispatched run: 'run' or 'skip'. One table, one place. */
export const RULES = {
  'session-start': { subagent: 'skip', quiet: 'skip', dispatched: 'run' }, // no brief, no registration, no token for -p
  'user-prompt': { subagent: 'skip', quiet: 'skip', dispatched: 'run' }, // a subagent's prompt is not the person's
  'tool-batch': { subagent: 'skip', quiet: 'skip', dispatched: 'run' },
  'tool-start': { subagent: 'skip', quiet: 'skip', dispatched: 'run' },
  notification: { subagent: 'run', quiet: 'skip', dispatched: 'run' }, // a subagent at a permission prompt: the session really waits for its person
  stop: { subagent: 'skip', quiet: 'run', dispatched: 'run' }, // Stop is the main conversation's; a -p run that changed files is still asked to save State once
  wait: { subagent: 'skip', quiet: 'skip', dispatched: 'skip' }, // and it ends when the parent claude process is gone
  'session-end': { subagent: 'skip', quiet: 'skip', dispatched: 'run' },
  'pre-tool': { subagent: 'run', quiet: 'run', dispatched: 'run' }, // the guards
  'post-tool': { subagent: 'run', quiet: 'run', dispatched: 'run' }, // the WORK-STATE.md copy; holdsNow is kept from the session's own answers only
  'subagent-start': { subagent: 'run', quiet: 'run', dispatched: 'run' },
};

const QUIET = /^sdk/i;
const procFile = (sid) => path.join(HERE, 'sessions', String(sid).toLowerCase() + '.proc');
const CHECK_START_MS = 10 * 60_000;

/** The parent claude process: found once, checked by the wait (tests replace these). */
export const parent = {
  /** { pid, procStart? }: CLAUDE_PID with the start time the session's .proc file kept for that pid, else the nearest claude ancestor. */
  find: (env = process.env, sid = null) => {
    const pid = /^\d{1,10}$/.test(env.CLAUDE_PID || '') && Number(env.CLAUDE_PID) > 0 ? Number(env.CLAUDE_PID) : 0;
    if (pid) {
      let procStart;
      try { const p = sid ? JSON.parse(fs.readFileSync(procFile(sid), 'utf8')) : null; if (p && p.pid === pid && typeof p.procStart === 'string') procStart = p.procStart; } catch { /* no .proc: the pid alone */ }
      return { pid, ...(procStart ? { procStart } : {}) };
    }
    return claudeProcess(env);
  },
  /** The process lives: kill 0 every time; its start time (when known) checked again every 10 minutes, so a reused pid is caught. */
  alive: (owner, now = Date.now()) => {
    try { process.kill(owner.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    if (!owner.procStart) return true;
    if (owner.checkedAt && now - owner.checkedAt < CHECK_START_MS) return true;
    const f = parent.facts(owner.pid);
    owner.checkedAt = now;
    return !f || !f.start || f.start === owner.procStart; // no answer: trust kill 0
  },
  facts: (pid) => processFacts(pid),
  everyMs: 2_000,
};

/**
 * The gate for one hook call: { run, why?, sid, subagent, quiet, dispatched, reports, hasParent(), parentGone() }. `run` false:
 * the hook does nothing and prints nothing. `reports`: this call may post the session's state (the main conversation of a
 * session with a person or a dispatched task). The parent is looked up on first use only.
 */
export function gate(event, input, env = process.env) {
  const sid = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  const subagent = !!input?.agent_id;
  const quiet = QUIET.test(String(env.CLAUDE_CODE_ENTRYPOINT || ''));
  const dispatched = /^[0-9]{1,9}$/.test(String(env.WORK_OS_DISPATCHED || ''));
  let owner;
  const ownerOf = () => {
    if (owner === undefined) { try { owner = parent.find(env, sid) ?? null; } catch { owner = null; } }
    return owner;
  };
  const hasParent = () => !!ownerOf();
  const parentGone = () => !!ownerOf() && !parent.alive(owner);
  const g = { sid, subagent, quiet, dispatched, reports: !!sid && !subagent && !quiet, parentGone, hasParent };
  const rule = RULES[event];
  if (!rule) return { ...g, run: true }; // an event with no row (main already refuses events outside EVENTS): no case applies
  // No session id: each hook already does nothing that needs one (the guards still run).
  if (subagent && rule.subagent === 'skip') return { ...g, run: false, why: 'subagent' };
  if (quiet && rule.quiet === 'skip') return { ...g, run: false, why: 'quiet run' };
  if (dispatched && rule.dispatched === 'skip') return { ...g, run: false, why: 'dispatched run' };
  return { ...g, run: true };
}
