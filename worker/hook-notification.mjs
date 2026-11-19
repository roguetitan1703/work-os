// Notification hook (async; permission_prompt|idle_prompt|elicitation_dialog): the session waits at a prompt, or sits idle.
// Only the notification type is sent, never the message text. Other types send nothing. Prints nothing.
import { postEvent } from './hook-lib.mjs';

const KINDS = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog']);

export async function notification(input) {
  const kind = input.notification_type;
  if (typeof kind === 'string' && KINDS.has(kind)) await postEvent(input.session_id, 'notify', { kind });
  return null;
}

export const handle = notification;
