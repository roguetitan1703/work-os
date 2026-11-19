// SessionEnd hook: the session closed, so Work OS shows it off. Prints nothing. Does not end the work (end_work stays the
// agent's own call). The hook is given 2 s, so the post gives up before hook.mjs does.
import { postEvent } from './hook-lib.mjs';

export async function sessionEnd(input) {
  await postEvent(input.session_id, 'end', {}, 1200);
  return null;
}

export const handle = sessionEnd;
