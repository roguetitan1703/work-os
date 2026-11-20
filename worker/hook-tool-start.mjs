// PreToolUse hook for Bash and PowerShell (async, so it never delays the tool): a call began. Work OS keeps the session working until a later event,
// because a long call (a 40-minute test run) sends nothing until it ends. Sends the event only, never the command. A subagent's call
// (agent_id set) sends nothing: it shares its parent's session id, and a background subagent working after the parent's Stop would mark
// the idle parent working, so its wait gives up and a message can't wake it. No token, a slow or failed call: nothing. Prints nothing.
import { postEvent } from './hook-lib.mjs';

export async function toolStart(input) {
  if (input.session_id && !input.agent_id) await postEvent(input.session_id, 'tool-start');
  return null;
}

export const handle = toolStart;
