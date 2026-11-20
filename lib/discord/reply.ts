import 'server-only';
import { InputError, NotFoundError } from '../data/errors';
import { orgWide, scoped, type Scope } from '../scope';
import { editReply, mdLink, postReply } from './recorded';

// discord_reply (plan v4 section 6): the one line an agent says back on Discord about a task that came from there. The first line on
// a bug-channel issue replaces the bot's "Recorded #N" reply (its buttons stay): "Recorded #N: <text>"; every later line is a new reply
// under the original message. A message the agent did not get from Discord is never answered, and nothing is ever posted to a channel
// at large: only under the message the task was made from. Mentions are off (the bot cannot ping anyone).

export const REPLY_MAX = 140;

export async function replyOnDiscord(s: Scope, ref: number, text: string, baseUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')): Promise<{ task: number; did: 'edited the Recorded reply' | 'posted a new reply' }> {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) throw new InputError('Say what to post: one short line.');
  if (line.length > REPLY_MAX) throw new InputError(`One short line, ${REPLY_MAX} characters at most (this is ${line.length}).`);
  const t = await (await scoped(s)).tasks.findOne({ ref });
  if (!t) throw new NotFoundError(`Task #${ref} not found.`);
  const src = t.source;
  if (!src || src.kind !== 'discord') throw new InputError(`#${ref} did not come from Discord, so there is nothing to answer there.`);
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
