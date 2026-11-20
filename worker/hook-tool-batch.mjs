// PostToolBatch hook: a batch of tool calls ended and the session carries on. At most one post every 20 s per session (and at once
// when the session was waiting at a prompt that has been answered): tell Work OS it is working, and hand over a message waiting
// for it (all that is unread for it, framed by the server) as context for the next step. A subagent shares its parent's session
// id and gets nothing. No token, a slow or failed call: no output. The hook is given 3 s; the post gives up after 1.5.
import { deliverOut, postEvent, readMarker, updateMarker } from './hook-lib.mjs';

const EVERY_MS = 20_000;

export async function toolBatch(input) {
  const sid = input.session_id;
  if (!sid) return null; // a subagent's batch never gets here (hook-gate.mjs)
  const m = readMarker(sid);
  if (!m?.presence) return null; // a session with no Work OS token never posts
  if (m.presence.state !== 'waiting' && Date.now() - (m.lastTool || 0) < EVERY_MS) return null;
  const r = await postEvent(sid, 'tool', { deliver: true });
  updateMarker(sid, (after) => ({ ...after, lastTool: Date.now() }));
  return deliverOut('PostToolBatch', r, sid);
}

export const handle = toolBatch;
