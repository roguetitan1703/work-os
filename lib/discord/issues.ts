import 'server-only';
import { addComment } from '../data/tasks';
import { leadOf, sendMessage, type SendTarget } from '../data/messages';
import { memberNames } from '../people';
import { discordUser } from '../profile';
import { orgWide, type Scope } from '../scope';
import type { ProjectDoc, TaskDoc } from '../db';
import type { Actor } from '../actors';
import { authorName, fetchMessages, snowflakeAt, type RawMessage } from './client';
import { plainText, taskFromMessage } from './to-task';
import { clipText, mdLink, plainName, postReply, recordedComponents } from './recorded';

// Bug channels (plan v4 section 2). A project's Discord channel (ProjectDoc.discordChannel) with "Every post is an issue" on:
// a new post from a person (not a bot, not a Discord reply) becomes a task on that project; the bot replies under it with
// "Recorded #N" and the buttons; the project's lead session gets a Work OS message. A Discord reply to the post, or to the
// bot's reply, becomes a comment on the task and a message to the lead. Everything runs in the project owner's scope: the
// task is theirs to place, the same way the Mailloom intake works. The author is the linked Work OS person, else the Discord
// display name. Discord's words are data: the message to the lead is marked so (MessageDoc.via 'discord-issue').

const BACKFILL_DAYS = 7;
const MAX_CATCH_UP = 300;
const g = globalThis as unknown as { __workosDiscordBusy?: Set<string> };
/** Posts being recorded right now (a second delivery of the same event waits for nothing: it is dropped). */
const busy = (g.__workosDiscordBusy ??= new Set());

export type BugChannel = NonNullable<ProjectDoc['discordChannel']>;

/** The project that has this channel, or null. */
export async function projectOfChannel(orgId: string, channelId: string): Promise<ProjectDoc | null> {
  return (await (await orgWide(orgId)).projects.findOne({ 'discordChannel.channelId': channelId })) ?? null;
}

/** The live task recorded from this message (a trashed task is not live: the message is recorded again). */
export async function liveTaskOfMessage(orgId: string, messageId: string): Promise<TaskDoc | null> {
  return (await (await orgWide(orgId)).tasks.findOne({ 'source.messageId': messageId, 'source.kind': 'discord' })) ?? null;
}

const ownerScope = (p: Pick<ProjectDoc, 'orgId' | 'ownerId'>): Scope => ({ userId: p.ownerId, orgId: p.orgId });

/** The first 200 characters of what was said, and how many screenshots came with it. */
function lineOf(m: RawMessage, text: string): string {
  const files = m.attachments.length;
  return `${clipText(text, 200)}${files ? ` (+${files} ${files === 1 ? 'screenshot' : 'screenshots'})` : ''}`.trim();
}

async function whoWrote(orgId: string, guildId: string, m: RawMessage): Promise<{ name: string; userId: string | null }> {
  const linked = await discordUser(guildId, m.author.id);
  if (linked) return { name: (await memberNames(orgId))[linked.userId] ?? authorName(m), userId: linked.userId };
  return { name: authorName(m), userId: null };
}

/** A Work OS message from the project's Discord channel to its lead session (or, with none live, to the project's owner's next start). */
async function tellLead(project: ProjectDoc, body: string, taskRef: number): Promise<void> {
  const s = ownerScope(project);
  try {
    const lead = await leadOf(s, project);
    const target: SendTarget = lead ? { kind: 'session', rows: [lead], project } : { kind: 'reply', project, toSids: [] };
    await sendMessage(s, target, { kind: 'fyi', body: clipText(body, 1000), refs: { tasks: [taskRef] } }, { word: 'agent', ai: 'Work OS', actor: { kind: 'system' } }, { via: 'discord-issue' });
  } catch (e) {
    console.error('[discord] message to the lead failed:', e instanceof Error ? e.message : e);
  }
}

/** Records one post as an issue. Returns the task, or null when it is not one (a bot, a reply, a post already recorded). */
async function recordPost(orgId: string, guildId: string, project: ProjectDoc, m: RawMessage, baseUrl: string): Promise<TaskDoc | null> {
  const ch = project.discordChannel!;
  const text = plainText(m);
  if (!text && !m.attachments.length) return null; // a sticker or an empty post: nothing to record
  if (await liveTaskOfMessage(orgId, m.id)) return null;
  const who = await whoWrote(orgId, guildId, m);
  const s = ownerScope(project);
  const actor: Actor = { kind: 'discord', ...(who.userId ? { userId: who.userId } : { name: who.name.slice(0, 80) }) };
  const { task, existing } = await taskFromMessage(
    s,
    m,
    { guildId, channelName: ch.name },
    actor,
    {
      project: project._id,
      mode: 'Code & Dev',
      priority: 'P2',
      createProject: false,
      tracked: 'issue',
      sourceExtra: { authorId: m.author.id },
      authorName: who.name,
      ...(who.userId ? { authorUser: who.userId } : {}),
      attachmentLinks: true,
      emptyTitle: `Issue from ${plainName(who.name) || 'Discord'}`,
      noDue: true,
      note: `From Discord post by ${who.name} in #${ch.name}`,
    },
  );
  if (existing) return null;
  const url = `${baseUrl}/tasks/${task.ref}`;
  const replyId = await postReply(m.channel_id, m.id, `Recorded ${mdLink(`#${task.ref}`, url)}`, await recordedComponents(orgId, task.ref));
  if (replyId) await (await orgWide(orgId)).tasks.updateOne({ _id: task.id }, { $set: { 'source.replyId': replyId, 'source.replyChannelId': m.channel_id } });
  await tellLead(project, `New issue #${task.ref} from ${plainName(who.name) || 'someone'}: ${lineOf(m, text || '(no text)')}`, task.ref);
  return (await (await orgWide(orgId)).tasks.findOne({ _id: task.id })) ?? null;
}

/** A Discord reply to an issue's post, or to the bot's reply under it: a comment on the task and a message to the lead. */
async function recordReply(orgId: string, guildId: string, project: ProjectDoc, m: RawMessage): Promise<boolean> {
  const to = m.message_reference?.message_id;
  if (!to) return false;
  const task = await (await orgWide(orgId)).tasks.findOne({ 'source.tracked': 'issue', projectId: project._id, $or: [{ 'source.messageId': to }, { 'source.replyId': to }] });
  if (!task) return false;
  const text = plainText(m) || (m.attachments.length ? `(${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'})` : '');
  if (!text) return false;
  const who = await whoWrote(orgId, guildId, m);
  const actor: Actor = { kind: 'discord', ...(who.userId ? { userId: who.userId } : { name: who.name.slice(0, 80) }) };
  // One comment per Discord message: the live event and the catch-up can both bring the same reply (claimed on the task, atomically).
  const claim = await (await orgWide(orgId)).tasks.updateOne({ _id: task._id, 'source.seenIds': { $ne: m.id } }, { $push: { 'source.seenIds': { $each: [m.id], $slice: -300 } } } as never);
  if (!claim.modifiedCount) return false;
  const note = who.userId ? clipText(text, 2000) : `${plainName(who.name) || 'Someone'} (Discord): ${clipText(text, 1900)}`;
  try {
    await addComment(ownerScope(project), task.ref, note, actor, { discordMessageId: m.id });
  } catch (e) {
    // Free the claim so the catch-up can record this reply later.
    await (await orgWide(orgId)).tasks.updateOne({ _id: task._id }, { $pull: { 'source.seenIds': m.id } } as never);
    throw e;
  }
  await tellLead(project, `Reply on #${task.ref} from ${plainName(who.name) || 'someone'}: ${lineOf(m, text)}`, task.ref);
  return true;
}

/** Moves the catch-up pointer forward (never back). */
async function bumpAfter(orgId: string, project: ProjectDoc, id: string): Promise<void> {
  const cur = project.discordChannel?.after;
  if (cur && BigInt(cur) >= BigInt(id)) return;
  await (await orgWide(orgId)).projects.updateOne({ _id: project._id, 'discordChannel.channelId': project.discordChannel!.channelId }, { $set: { 'discordChannel.after': id } });
  project.discordChannel!.after = id;
}

/** One message that arrived in a project's channel (live, from the catch-up or the first set). */
export async function onChannelMessage(orgId: string, guildId: string, project: ProjectDoc, m: RawMessage, baseUrl: string): Promise<void> {
  const ch = project.discordChannel;
  if (!ch?.everyPost || m.channel_id !== ch.channelId) return;
  if (m.author?.bot || !m.author?.id) return;
  if (m.type !== 0 && m.type !== 19) return;
  const key = `${orgId}:${m.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    if (m.message_reference?.message_id) await recordReply(orgId, guildId, project, m);
    else await recordPost(orgId, guildId, project, m, baseUrl);
    await bumpAfter(orgId, project, m.id);
  } finally {
    busy.delete(key);
  }
}

/** The gateway's MESSAGE_CREATE. */
export async function onMessageCreate(orgId: string, guildId: string, m: RawMessage, baseUrl: string): Promise<void> {
  if (!m?.id || !m.channel_id) return;
  const project = await projectOfChannel(orgId, m.channel_id);
  if (project) await onChannelMessage(orgId, guildId, project, m, baseUrl);
}

/** Reads a channel forward and records what it holds (oldest first), at most MAX_CATCH_UP messages. */
async function readForward(orgId: string, guildId: string, project: ProjectDoc, opts: { after?: string; since?: Date }, baseUrl: string): Promise<number> {
  const ch = project.discordChannel!;
  const { messages } = await fetchMessages(ch.channelId, { ...(opts.after ? { after: opts.after } : { since: opts.since }), maxPages: Math.ceil(MAX_CATCH_UP / 100) });
  let n = 0;
  for (const m of messages.slice(0, MAX_CATCH_UP)) {
    await onChannelMessage(orgId, guildId, project, { ...m, channel_id: ch.channelId }, baseUrl);
    n++;
  }
  return n;
}

/** After a gap (READY, RESUMED): every bug channel of the server is read from the last message handled. */
export async function catchUp(orgId: string, guildId: string, baseUrl: string): Promise<number> {
  const projects = await (await orgWide(orgId)).projects.find({ 'discordChannel.everyPost': true, 'discordChannel.after': { $exists: true } }).toArray();
  let n = 0;
  for (const p of projects) {
    try {
      n += await readForward(orgId, guildId, p, { after: p.discordChannel!.after }, baseUrl);
    } catch (e) {
      console.error('[discord] catch-up failed for a channel:', e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/**
 * When a project first gets a channel with every post an issue: its posts of the last 7 days that have no live task are
 * recorded, once (claimed by setting `backfilledAt`). A channel set again later is not read back.
 */
export async function backfill(orgId: string, guildId: string, projectId: string, baseUrl: string): Promise<number> {
  const c = await orgWide(orgId);
  const claimed = await c.projects.findOneAndUpdate(
    { _id: projectId, 'discordChannel.everyPost': true, 'discordChannel.backfilledAt': { $exists: false } },
    { $set: { 'discordChannel.backfilledAt': new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed?.discordChannel) return 0;
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  let n = 0;
  try {
    n = await readForward(orgId, guildId, claimed, { since }, baseUrl);
  } catch (e) {
    console.error('[discord] first set failed:', e instanceof Error ? e.message : e);
    // Released so it can be tried again by setting the channel once more.
    await c.projects.updateOne({ _id: projectId }, { $unset: { 'discordChannel.backfilledAt': '' } });
    throw e;
  }
  // From here on the catch-up starts at the newest message of the window (even when nothing was recorded).
  if (!claimed.discordChannel.after) await c.projects.updateOne({ _id: projectId, 'discordChannel.after': { $exists: false } }, { $set: { 'discordChannel.after': snowflakeAt(new Date()) } });
  return n;
}

