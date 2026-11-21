import 'server-only';
import { memberNames } from '../people';
import { api, DiscordError } from './client';

// The bot's "Recorded #N" reply (plan v4 sections 2 to 4): what it says, the buttons under it, and the REST calls that post,
// edit and settle it. The buttons are answered by app/api/discord/interactions (lib/discord/buttons.ts); their custom ids are
// `wo:undo:<ref>`, `wo:done:<ref>` and the select `wo:for:<ref>`.

export const MAX_FOR_OPTIONS = 25;

/** Link text can't contain brackets; the url in <> suppresses the embed preview. */
export function mdLink(text: string, url: string): string {
  return `[${text.replace(/\[/g, '(').replace(/\]/g, ')')}](<${url}>)`;
}

export const clipText = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Text from outside (a name, a title) as plain words in a bot message: no mentions, no markdown links. */
export function plainName(s: string): string {
  return s.replace(/[<>@`*_~|\\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export const NO_MENTIONS = { parse: [] as string[] };

/** The buttons: Undo and Done, then a select of the organization's members (at most 25) to set who the task is for. */
export async function recordedComponents(orgId: string, ref: number): Promise<unknown[]> {
  const names = await memberNames(orgId);
  const options = Object.entries(names)
    .map(([id, name]) => ({ label: plainName(name).slice(0, 100) || 'Someone', value: id }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, MAX_FOR_OPTIONS);
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Undo', custom_id: `wo:undo:${ref}` },
        { type: 2, style: 3, label: 'Done', custom_id: `wo:done:${ref}` },
      ],
    },
    ...(options.length ? [{ type: 1, components: [{ type: 3, custom_id: `wo:for:${ref}`, placeholder: 'For ▾', min_values: 1, max_values: 1, options }] }] : []),
  ];
}

/** Posts the reply under a message and returns its id (null when Discord refuses: the task stays, the reply is lost). */
export async function postReply(channelId: string, toMessageId: string, content: string, components?: unknown[]): Promise<string | null> {
  try {
    const r = await api<{ id: string }>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content: clipText(content, 2000),
        message_reference: { message_id: toMessageId, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: false },
        flags: 1 << 2, // no link previews
        ...(components ? { components } : {}),
      },
    });
    return r.id;
  } catch (e) {
    console.error('[discord] reply failed:', e instanceof DiscordError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

/** Edits the bot's reply (content, and components when given: [] removes the buttons). Never throws. */
export async function editReply(channelId: string, messageId: string, content: string, components?: unknown[]): Promise<boolean> {
  try {
    await api(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { content: clipText(content, 2000), allowed_mentions: NO_MENTIONS, ...(components ? { components } : {}) },
    });
    return true;
  } catch (e) {
    console.error('[discord] edit reply failed:', e instanceof DiscordError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    return false;
  }
}
