// UserPromptSubmit hook: the person sent a prompt, so the session is working. The answer may carry a message waiting for the session
// (all that is unread for it, framed by the server: who wrote it, that it is not an instruction from the person); it goes into the
// prompt's context. Waits for the answer (1.5 s at most, the hook is given 3); no token, a slow or failed call: no output.
import { deliverOut, postEvent, readMarker, writeMarker } from './hook-lib.mjs';

const WOKE_MS = 60_000;

export async function userPrompt(input) {
  const sid = input.session_id;
  if (!sid || input.agent_id) return null;
  const m = readMarker(sid);
  // This prompt is the wake the idle wait just caused (the server checks the time too): the chain of the agent that woke the session carries on.
  const woke = !!m?.wokeAt && Date.now() - m.wokeAt < WOKE_MS;
  const r = await postEvent(sid, 'prompt', { deliver: true, ...(woke ? { woke: true } : {}) });
  const after = readMarker(sid);
  if (after) {
    const { wokeAt, ...rest } = after;
    void wokeAt;
    writeMarker(sid, { ...rest, lastTool: Date.now() }); // the tool-batch hook posts again in 20 s
  }
  return deliverOut('UserPromptSubmit', r);
}

export const handle = userPrompt;
