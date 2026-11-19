// PreToolUse hook for Bash and PowerShell (async, so it never delays the tool): a call began. Work OS keeps the session working until a later event,
// because a long call (a 40-minute test run) sends nothing until it ends. Sends the event only, never the command. A subagent's call counts too
// (it shares its parent's session id). No token, a slow or failed call: nothing. Prints nothing.
import { postEvent } from './hook-lib.mjs';

export async function toolStart(input) {
  if (input.session_id) await postEvent(input.session_id, 'tool-start');
  return null;
}

export const handle = toolStart;
