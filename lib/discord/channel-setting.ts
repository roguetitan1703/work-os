import 'server-only';
import { InputError, NotFoundError } from '../data/errors';
import { discordLinkOf } from '../profile';
import { orgWide, scoped, type Scope } from '../scope';
import { fetchMessages, guildContext, type DiscordLink } from './client';

// A project's Discord channel (plan v4 section 2): one channel per project and one switch, "Every post is an issue". Set in the
// app only (a server action), by anyone who can edit the project, from the channels their own linked Discord account can see
// (never a blocked one): the bot then records that channel's posts (lib/discord/issues.ts) and the track emoji reads the
// channel as the project of a marked message. A channel belongs to one project of the organization.

export type ChannelSetting = { channelId: string; name: string; everyPost: boolean };
export type ChannelChoice = { id: string; name: string; category: string | null };
export type ChannelView = { setting: ChannelSetting | null; /** The organization has a Discord server. */ server: boolean; /** The person has connected their Discord (they can pick a channel). */ linked: boolean; channels: ChannelChoice[]; /** Channels already taken by another project. */ taken: Record<string, string> };

const TEXT = new Set(['text', 'announcement']);

async function choicesFor(link: DiscordLink): Promise<ChannelChoice[]> {
  const ctx = await guildContext(link);
  return ctx.layout
    .filter(c => TEXT.has(c.type) && !c.blocked && ctx.visible.has(c.id))
    .map(c => ({ id: c.id, name: c.name, category: c.parentId ? (ctx.layout.find(x => x.id === c.parentId)?.name ?? null) : null }));
}

/** What the project page shows: the setting, and the channels the person can pick. */
export async function channelView(s: Scope, projectId: string): Promise<ChannelView> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: projectId }, { projection: { discordChannel: 1 } });
  if (!p) throw new NotFoundError('Project not found');
  const setting = p.discordChannel ? { channelId: p.discordChannel.channelId, name: p.discordChannel.name, everyPost: p.discordChannel.everyPost } : null;
  const link = await discordLinkOf(s);
  if (!link) return { setting, server: false, linked: false, channels: [], taken: {} };
  if (!link.discordId) return { setting, server: true, linked: false, channels: [], taken: {} };
  const channels = await choicesFor(link).catch(() => [] as ChannelChoice[]);
  const others = await c.projects.find({ _id: { $ne: projectId }, 'discordChannel.channelId': { $exists: true } }, { projection: { name: 1, discordChannel: 1 } }).toArray();
  return { setting, server: true, linked: true, channels, taken: Object.fromEntries(others.map(o => [o.discordChannel!.channelId, o.name])) };
}

/**
 * Sets (or clears, channelId null) the project's channel. A channel already used by another project is refused. Returns what
 * was saved, and whether the first set of this channel is due (the caller runs it after the response: lib/discord/issues.ts backfill).
 */
export async function setDiscordChannel(s: Scope, projectId: string, input: { channelId: string | null; everyPost: boolean }): Promise<{ setting: ChannelSetting | null; backfill: boolean; guildId: string | null }> {
  const c = await scoped(s);
  const cur = await c.projects.findOne({ _id: projectId });
  if (!cur) throw new NotFoundError('Project not found');
  const now = new Date();
  if (input.channelId === null) {
    await c.projects.updateOne({ _id: projectId }, { $unset: { discordChannel: '' }, $set: { updatedAt: now } });
    return { setting: null, backfill: false, guildId: null };
  }
  const link = await discordLinkOf(s);
  if (!link) throw new InputError('This organization has no Discord server set.');
  if (!link.discordId) throw new InputError('Connect your Discord first (Settings › Connections): you pick from the channels your account can see.');
  const choice = (await choicesFor(link)).find(x => x.id === input.channelId);
  if (!choice) throw new InputError('Pick a text channel your Discord account can see (not one marked sensitive).');
  const other = await (await orgWide(s.orgId)).projects.findOne({ _id: { $ne: projectId }, 'discordChannel.channelId': choice.id }, { projection: { name: 1 } });
  if (other) throw new InputError(`#${choice.name} is already the channel of ${other.name}.`);
  try {
    await fetchMessages(choice.id, { limit: 1 });
  } catch {
    throw new InputError(`The Work OS bot cannot read #${choice.name}: give it View Channel and Read Message History there.`);
  }
  const same = cur.discordChannel?.channelId === choice.id;
  const doc = {
    channelId: choice.id,
    name: choice.name,
    everyPost: input.everyPost === true,
    ...(same && cur.discordChannel?.after ? { after: cur.discordChannel.after } : {}),
    ...(same && cur.discordChannel?.backfilledAt ? { backfilledAt: cur.discordChannel.backfilledAt } : {}),
    setBy: s.userId,
    setAt: now,
  };
  await c.projects.updateOne({ _id: projectId }, { $set: { discordChannel: doc, updatedAt: now } });
  return { setting: { channelId: doc.channelId, name: doc.name, everyPost: doc.everyPost }, backfill: doc.everyPost && !doc.backfilledAt, guildId: link.guildId };
}
