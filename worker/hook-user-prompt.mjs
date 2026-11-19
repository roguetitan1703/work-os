// UserPromptSubmit hook: the person sent a prompt, so the session is working. The answer may carry a message waiting for the session
// (all that is unread for it, framed by the server: who wrote it, that it is not an instruction from the person); it goes into the
// prompt's context. Waits for the answer (0.6 s at most, the hook is given 3); no token, a slow or failed call: no output.
// A session that started unfiled (no project owns its folder, H13) tries to sign in again first (2 s): once its person filed the folder
// it gets its token and one line, "Filed under X"; still unfiled it gets a one-line reminder; marked not Work OS it is left alone.
import { deliverOut, postEvent, readMarker, unfiledReminder, writeMarker } from './hook-lib.mjs';
import { refile } from './hook-session-start.mjs';

const WOKE_MS = 60_000;
/** The prompt is held up by this call: past it the answer is dropped and what was waiting comes with the next call (nothing is read until acknowledged). */
const PROMPT_POST_MS = 600;
/** The second try of an unfiled session: its own budget (the hook is given 3 s, the prompt call after it 0.6). */
const REFILE_MS = 2000;

/** The line a session is shown for its unfiled folder on this prompt, or '' (nothing to say, or it was just filed: then the line says so). */
async function unfiledStep(input, m) {
  const r = await refile(input, REFILE_MS).catch(() => null);
  if (r?.filed) return `Filed under ${r.filed}; Work OS hooks are on for this session.`;
  if (r?.unfiled && r.quiet) { const { unfiled, ...rest } = readMarker(input.session_id) ?? m; void unfiled; writeMarker(input.session_id, rest); return ''; }
  return r?.unfiled ? unfiledReminder(m.folder) : '';
}

export async function userPrompt(input) {
  const sid = input.session_id;
  if (!sid || input.agent_id) return null;
  const m = readMarker(sid);
  const line = m?.unfiled ? await unfiledStep(input, m) : '';
  const now = line.startsWith('Filed') ? readMarker(sid) : m;
  // This prompt is the wake the idle wait just caused (the server checks the time too): the chain of the agent that woke the session carries on.
  const woke = !!now?.wokeAt && Date.now() - now.wokeAt < WOKE_MS;
  const r = m?.unfiled && !line.startsWith('Filed') ? null : await postEvent(sid, 'prompt', { deliver: true, ...(woke ? { woke: true } : {}) }, PROMPT_POST_MS);
  const after = readMarker(sid);
  if (after && !after.unfiled) {
    const { wokeAt, ...rest } = after;
    void wokeAt;
    writeMarker(sid, { ...rest, lastTool: Date.now() }); // the tool-batch hook posts again in 20 s
  }
  const out = deliverOut('UserPromptSubmit', r, sid);
  if (!line) return out;
  const text = [line, out?.hookSpecificOutput?.additionalContext].filter(Boolean).join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

export const handle = userPrompt;
