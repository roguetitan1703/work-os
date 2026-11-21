import 'server-only';
import { InputError, NotFoundError } from '../data/errors';
import { orgWide, scoped, type Scope } from '../scope';
import { assertNotBlocked, BlockedChannelError, guildContext, NotVisibleError } from './client';
import type { DiscordLink } from './client';
import { editReply, mdLink, postReply } from './recorded';

// discord_reply (plan v4 section 6): the one line an agent says back on Discord about a task that came from there. The first line on
// a bug-channel issue replaces the bot's "Recorded #N" reply (its buttons stay): "Recorded #N: <text>"; every later line is a new reply
// under the original message. A message the agent did not get from Discord is never answered, and nothing is ever posted to a channel
// at large: only under the message the task was made from. Mentions are off (the bot cannot ping anyone).

export const REPLY_MAX = 140;

/** Links and addresses are not posted (a reply is plain words): [x](url) becomes x, a bare URL goes. */
export function plainLine(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<?\b(?:https?:\/\/|www\.)[^\s<>]+>?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function replyOnDiscord(s: Scope, link: DiscordLink, ref: number, text: string, baseUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')): Promise<{ task: number; did: 'edited the Recorded reply' | 'posted a new reply' }> {
  const line = plainLine(text);
  if (!line) throw new InputError('Say what to post: one short line.');
  if (line.length > REPLY_MAX) throw new InputError(`One short line, ${REPLY_MAX} characters at most (this is ${line.length}).`);
  const t = await (await scoped(s)).tasks.findOne({ ref });
  if (!t) throw new NotFoundError(`Task #${ref} not found.`);
  const src = t.source;
  if (!src || src.kind !== 'discord') throw new InputError(`#${ref} did not come from Discord, so there is nothing to answer there.`);
  // Only where the caller's own Discord account can read: a task from a channel they cannot see is not answered by them.
  try {
    await assertNotBlocked(await guildContext(link), src.channelId);
  } catch (e) {
    if (e instanceof BlockedChannelError || e instanceof NotVisibleError) throw new InputError(`#${ref}'s Discord channel is not readable for your account, so it is not answered.`);
    throw e;
  }
  const first = src.tracked === 'issue' && !src.noted && !!src.replyId && !!src.replyChannelId;
  if (first) {
    const label = baseUrl ? mdLink(`#${ref}`, `${baseUrl}/tasks/${ref}`) : `#${ref}`;
    if (await editReply(src.replyChannelId!, src.replyId!, `Recorded ${label}: ${line}`)) {
      await (await orgWide(s.orgId)).tasks.updateOne({ _id: t._id }, { $set: { 'source.noted': true } });
      return { task: ref, did: 'edited the Recorded reply' };
    }
  }
  const id = await postReply(src.channelId, src.messageId, line);
  if (!id) throw new InputError('Discord did not take the reply (the message may be gone, or the bot may not be allowed to post there).');
  if (!src.noted) await (await orgWide(s.orgId)).tasks.updateOne({ _id: t._id }, { $set: { 'source.noted': true } });
  return { task: ref, did: 'posted a new reply' };
}
