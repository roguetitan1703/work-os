// UserPromptSubmit hook (async): the person sent a prompt, so the session is working. Prints nothing, never blocks.
import { postEvent } from './hook-lib.mjs';

export async function userPrompt(input) {
  await postEvent(input.session_id, 'prompt');
  return null;
}

export const handle = userPrompt;
