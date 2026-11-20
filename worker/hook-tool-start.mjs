// PreToolUse hook for Bash and PowerShell (async, so it never delays the tool): a call began. Work OS keeps the session working until a later event,
// because a long call (a 40-minute test run) sends nothing until it ends. Sends the event only, never the command. A subagent's call
// and a -p run never get here (hook-gate.mjs RULES). No token, a slow or failed call: nothing. Prints nothing.
// One heartbeat (hooks review H4): while the marker says this session was marked open less than 30 s ago, another call sends
// nothing (the row is still open; the server counts a repeat as free anyway, this saves the request).
import { postEvent, readMarker } from './hook-lib.mjs';

export const OPEN_EVERY_MS = 30_000;

export async function toolStart(input) {
  const sid = input.session_id;
  if (!sid) return null;
  const p = readMarker(sid)?.presence;
  if (p?.open && p.state === 'working' && Date.now() - (p.at || 0) < OPEN_EVERY_MS) return null;
  await postEvent(sid, 'tool-start');
  return null;
}

export const handle = toolStart;
