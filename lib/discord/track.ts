import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memberNames } from '../people';
import { discordUser } from '../profile';
import { getOrgSetting, orgWide, scoped, setOrgSetting, type Scope } from '../scope';
import type { Actor } from '../actors';
import type { ProjectDoc } from '../db';
import { api, assertNotBlocked, BlockedChannelError, DiscordError, fetchMessage, findChannel, guildContext, NotVisibleError, type ChannelInfo, type RawMessage } from './client';
import { liveTaskOfMessage, projectOfChannel } from './issues';
import { mdLink, plainName, postReply, recordedComponents } from './recorded';
import { taskFromMessage } from './to-task';

// The track emoji (plan v4 section 3). A linked member reacting with it on any message in any channel the bot can read makes a
// task. The emoji is a custom server emoji, :wos:, uploaded once through the bot (Manage Expressions) and kept in the
// organization's discord setting (`trackEmojiId`); the pin (📌) works too, always. The task's people are the linked people the
// message @mentions, else the person who reacted; its project is the one whose Discord channel the message is in, else none (the
// assignee's own list, private to them). A second reaction on a message already tracked does nothing. Someone not linked is told
// to connect (in the channel, with a mention: a reaction event has no private reply). What the message says is data.

export const TRACK_EMOJI_NAME = 'wos';
const PIN = '📌';
const g = globalThis as unknown as { __workosTrackBusy?: Set<string>; __workosTrackNoted?: Map<string, number>; __workosEmojiTried?: Map<string, number> };
const busy = (g.__workosTrackBusy ??= new Set());
const noted = (g.__workosTrackNoted ??= new Map());
const tried = (g.__workosEmojiTried ??= new Map());

/** The organization's track emoji id (a custom emoji of its server), or null until it exists. */
export async function trackEmojiId(orgId: string): Promise<string | null> {
  const id = (await getOrgSetting(orgId, 'discord'))?.trackEmojiId;
  return typeof id === 'string' && /^\d{15,22}$/.test(id) ? id : null;
}

/**
 * Makes sure the server has the :wos: emoji: adopts one that is there, else uploads the app's icon once. Tried at most once an
 * hour per process (a missing Manage Expressions permission is logged, never fatal: the pin works meanwhile).
 */
export async function ensureTrackEmoji(orgId: string, guildId: string): Promise<string | null> {
  const have = await trackEmojiId(orgId);
  if (have) return have;
  const last = tried.get(orgId) ?? 0;
  if (Date.now() - last < 3_600_000) return null;
  tried.set(orgId, Date.now());
  try {
    const list = await api<{ id: string; name: string }[]>(`/guilds/${guildId}/emojis`);
    let id = list.find(e => e.name === TRACK_EMOJI_NAME)?.id;
    if (!id) {
      const png = await readFile(join(process.cwd(), 'assets/brand/app-180.png'));
      id = (await api<{ id: string }>(`/guilds/${guildId}/emojis`, { method: 'POST', body: { name: TRACK_EMOJI_NAME, image: `data:image/png;base64,${png.toString('base64')}` } })).id;
    }
    await setOrgSetting(orgId, 'discord', { trackEmojiId: id, updatedAt: new Date() });
    return id;
  } catch (e) {
    console.error('[discord] track emoji not made (the pin still works):', e instanceof DiscordError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

type Emoji = { id?: string | null; name?: string | null };

/** Is this reaction the track emoji (the custom one, or the pin)? */
export async function isTrackEmoji(orgId: string, e: Emoji | undefined): Promise<boolean> {
  if (!e) return false;
  if (!e.id) return e.name === PIN;
  return e.id === (await trackEmojiId(orgId));
}

type Reaction = { user_id?: string; channel_id?: string; message_id?: string; emoji?: Emoji; member?: { user?: { bot?: boolean } } };

/** The project of a message's channel: the channel itself, or the channel a thread belongs to. */
async function projectOfMessageChannel(orgId: string, channelId: string, parentId: string | null): Promise<ProjectDoc | null> {
  return (await projectOfChannel(orgId, channelId)) ?? (parentId ? await projectOfChannel(orgId, parentId) : null);
}

/** A person who can read this project (their own door), as a place to own the task. */
async function canRead(s: Scope, projectId: string): Promise<boolean> {
  return !!(await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { _id: 1 } }));
}

/** Tells someone who is not linked to connect (once an hour per person; a reaction cannot be answered privately). */
async function askToConnect(channelId: string, messageId: string, userId: string, baseUrl: string): Promise<void> {
  const key = userId;
  if (Date.now() - (noted.get(key) ?? 0) < 3_600_000) return;
  if (noted.size > 500) noted.clear();
  noted.set(key, Date.now());
  const url = `${baseUrl}/settings?section=notifications`;
  try {
    await api(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content: `<@${userId}> Connect Discord in Work OS first: ${mdLink('Settings › Notifications', url)}`,
        message_reference: { message_id: messageId, fail_if_not_exists: false },
        allowed_mentions: { users: [userId], replied_user: false },
        flags: 1 << 2,
      },
    });
  } catch (e) {
    console.error('[discord] connect note failed:', e instanceof DiscordError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
  }
}

/** The gateway's MESSAGE_REACTION_ADD. */
export async function onReactionAdd(orgId: string, guildId: string, r: Reaction, baseUrl: string): Promise<void> {
  const { user_id: userId, channel_id: channelId, message_id: messageId } = r;
  if (!userId || !channelId || !messageId || r.member?.user?.bot) return;
  if (!(await isTrackEmoji(orgId, r.emoji))) return;
  const key = `${orgId}:${messageId}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    if (await liveTaskOfMessage(orgId, messageId)) return; // already tracked: nothing
    // What the reactor's own Discord account can see, minus the sensitive channels: never a channel they cannot read, and nothing
    // (not even the "connect" note) is posted in one.
    const ctx = await guildContext({ orgId, guildId, discordId: userId });
    try {
      await assertNotBlocked(ctx, channelId);
    } catch (e) {
      if (e instanceof BlockedChannelError || e instanceof NotVisibleError) return;
      throw e;
    }
    const reactor = await discordUser(guildId, userId);
    if (!reactor) return void (await askToConnect(channelId, messageId, userId, baseUrl));
    const m = await fetchMessage(channelId, messageId);
    if (m.author?.id === ctx.botId) return; // the bot's own messages are not tracked
    await track(orgId, guildId, reactor, m, findChannel(ctx, channelId), baseUrl);
  } finally {
    busy.delete(key);
  }
}

/** Makes the task from a marked message and answers under it. */
async function track(orgId: string, guildId: string, reactor: Scope, m: RawMessage, channel: ChannelInfo | undefined, baseUrl: string): Promise<void> {
  const names = await memberNames(orgId);
  // The linked people the message @mentions (bots, roles and @everyone are not people here); nobody mentioned: the reactor.
  const mentioned: string[] = [];
  const discordIdOf = new Map<string, string>();
  for (const u of m.mentions ?? []) {
    if (u.bot) continue;
    const p = await discordUser(guildId, u.id);
    if (p && !mentioned.includes(p.userId)) {
      mentioned.push(p.userId);
      discordIdOf.set(p.userId, u.id);
    }
  }
  const people = mentioned.length ? mentioned : [reactor.userId];
  const project = await projectOfMessageChannel(orgId, m.channel_id, channel?.parentId ?? null);
  // Who owns it and who it is for: the people who can read the project (their own door); without a project, the first person only (private to them).
  let owner: Scope;
  let assignees: string[];
  if (project) {
    const able: string[] = [];
    for (const id of people) if (await canRead({ userId: id, orgId }, project._id)) able.push(id);
    owner = { userId: able[0] ?? project.ownerId, orgId };
    assignees = able;
  } else {
    // With no project the task is private to its first person. Someone else than the reactor gets it only when their own Discord view
    // of the channel is confirmed; otherwise it stays private to the reactor (a mention must not hand a message to a person who cannot read it).
    let first = people[0];
    if (first !== reactor.userId) {
      let seen = false;
      try {
        const theirs = await guildContext({ orgId, guildId, discordId: discordIdOf.get(first) ?? '' });
        await assertNotBlocked(theirs, m.channel_id);
        seen = true;
      } catch {
        seen = false;
      }
      if (!seen) first = reactor.userId;
    }
    owner = { userId: first, orgId };
    assignees = [first];
  }
  const author = await discordUser(guildId, m.author.id);
  const actor: Actor = { kind: 'discord', userId: reactor.userId };
  const { task, existing } = await taskFromMessage(
    owner,
    m,
    { guildId, channel },
    actor,
    {
      project: project ? project._id : null,
      createProject: false,
      tracked: 'emoji',
      sourceExtra: { authorId: m.author.id, reactorId: reactor.userId },
      assignees,
      ...(author ? { authorUser: author.userId, authorName: names[author.userId] } : {}),
      note: `Marked with the track emoji by ${names[reactor.userId] ?? 'someone'}`,
    },
  );
  if (existing) return;
  const who = assignees.map(id => plainName(names[id] ?? '')).filter(Boolean).join(', ');
  const where = project ? plainName(project.name) : '';
  const url = `${baseUrl}/tasks/${task.ref}`;
  const content = `Recorded ${mdLink(`#${task.ref}`, url)}${who ? ` · ${who}` : ''}${where ? ` · ${where}` : ''}`;
  const replyId = await postReply(m.channel_id, m.id, content, await recordedComponents(orgId, task.ref));
  if (replyId) await (await orgWide(orgId)).tasks.updateOne({ _id: task.id }, { $set: { 'source.replyId': replyId, 'source.replyChannelId': m.channel_id } });
}

