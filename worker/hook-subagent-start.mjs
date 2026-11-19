// SubagentStart hook: a subagent (Task, Agent) starts with the short form of the organization Orders: the first ten rule lines,
// kept in the session's marker since the start brief (and replaced when the organization Orders change). A subagent does not
// get its parent's brief, so without this it would work without the rules. Reads the marker only: no network call, no key, no
// token; a session without a marker or a short form gets nothing. The event passes the parent's session_id.
import { readMarker } from './hook-lib.mjs';

/** Lanes step 3: fixed here because the short form is the organization's own Orders text, which may still say "save_state when you stop". */
export const SUBAGENT_PREFACE = 'Your parent records the State; never call save_state, import_state or end_work.';

export function subagentStart(input) {
  const sid = input.session_id;
  const m = sid ? readMarker(sid) : null;
  const short = typeof m?.short === 'string' ? m.short.trim() : '';
  if (!short) return null;
  const v = Number.isInteger(m.shortV) ? `v${m.shortV}; ` : '';
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `## Work OS Orders, short form (${v}the full Orders are in your parent's brief)\n${SUBAGENT_PREFACE}\n${short.slice(0, 1200)}` } };
}

export const handle = subagentStart;
