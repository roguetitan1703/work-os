import 'server-only';
import { ZodError } from 'zod';
import { InputError, NotFoundError } from '../data/errors';
import { BlockedChannelError, DiscordError, NotVisibleError } from './client';

// What Discord sends to the interactions endpoint (the part Work OS reads). The only interactions are the buttons and the select
// under the bot's replies (lib/discord/buttons.ts) and the direct-message Need buttons (until they are removed).
// There are no slash commands and no message commands: people use Work OS in Work OS, and the bot works from posts and the track emoji.

export type Interaction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { id: string; content: string };
  data?: {
    custom_id?: string;
    component_type?: number;
    values?: string[];
  };
};

export const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;
export const EPHEMERAL = 64;

/** What a person is told when a press fails: our own words, never an internal error. */
export function errorText(err: unknown): string {
  if (err instanceof ZodError) return 'Invalid input: ' + err.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  if (err instanceof InputError || err instanceof NotFoundError || err instanceof DiscordError || err instanceof BlockedChannelError || err instanceof NotVisibleError) return err.message;
  console.error('[discord] interaction failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  return 'Something went wrong. Check the server logs.';
}

/** A private reply to the person who pressed. */
export const ephemeral = (content: string) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
