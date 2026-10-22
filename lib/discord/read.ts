import 'server-only';
import { previousWorkdayStart, APP_TZ } from '../dates';
import { InputError, NotFoundError } from '../data/errors';
import {
  CONTENT_INTENT_WARNING,
  DiscordError,
  budget,
  excerpt,
  fetchMessage,
  fetchMessages,
  findChannel,
  guildContext,
  looksContentless,
  mapWithBudget,
  mentionsBot,
  mentionsMe,
  ownerInThread,
  parseMessageLink,
  snowflakeTime,
  toView,
  type ChannelInfo,
  type GuildContext,
  type MessageView,
  type RawMessage,
  assertNotBlocked,
  renderContent,
} from './client';
import { taskFromMessage, type MessageTaskOverrides, type MessageTaskResult } from './to-task';
import type { Actor } from '../types';
import type { Scope } from '../scope';

// Read-only views of the Discord server for the MCP tools. Many channels are handled by
// activity filtering: last_message_id (a snowflake) says when each channel/thread last moved,
// so only channels active since the cutoff are read.

const TIME_BUDGET_MS = 40_000; // stay well inside the 60s function limit

const where = (c: ChannelInfo) => (c.isThread && c.parentName ? `#${c.parentName} › ${c.name}` : `#${c.name}`);

// ── discord_list_channels ───────────────────────────────────────────────────

export async function listChannels(opts: { activeSince?: Date; includeThreads?: boolean } = {}) {
  const ctx = await guildContext();
  const since = opts.activeSince?.toISOString();
  const rows = ctx.channels
    .filter(c => opts.includeThreads !== false || !c.isThread)
    .filter(c => !since || (c.lastActivity && c.lastActivity >= since))
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  const shape = (c: ChannelInfo) => ({
    name: where(c),
    id: c.id,
    type: c.type,
    category: c.category,
    lastActivity: c.lastActivity,
    url: c.url,
  });
  return {
    timezone: APP_TZ,
    ...(since ? { activeSince: since } : {}),
    count: rows.filter(c => c.canRead).length,
    channels: rows.filter(c => c.canRead).map(shape),
    noAccess: rows.filter(c => !c.canRead).map(c => where(c)),
    ...(ctx.blocked.size ? { blockedInSettings: ctx.blocked.size } : {}),
    ...(ctx.contentIntent ? {} : { warning: CONTENT_INTENT_WARNING }),
  };
}

// ── discord_read_messages ───────────────────────────────────────────────────

export async function readMessages(q: {
  channel: string;
  since?: Date;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}) {
  const ctx = await guildContext();
  const ch = findChannel(ctx, q.channel);
  const channelId = ch?.id ?? q.channel.match(/channels\/\d+\/(\d+)/)?.[1] ?? (/^\d{15,22}$/.test(q.channel.trim()) ? q.channel.trim() : null);
  if (!channelId) throw new NotFoundError(`No channel or thread matches "${q.channel}". Use discord_list_channels to see names.`);
  await assertNotBlocked(ctx, channelId);
  if (ch && !ch.canRead) throw new InputError(`The bot can't read ${where(ch)} (missing View Channel / Read Message History there).`);

  const limit = Math.min(Math.max(q.limit ?? 50, 1), q.since ? 300 : 100);
  let res;
  try {
    res = await fetchMessages(channelId, { ...q, limit, maxPages: 3, budget: budget(TIME_BUDGET_MS) });
  } catch (e) {
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
      throw new InputError(e.status === 403 ? `The bot can't read that channel (403).` : `Channel not found (404).`);
    }
    throw e;
  }
  let msgs = res.messages;
  let truncated = res.truncated;
  if (msgs.length > limit) {
    msgs = msgs.slice(-limit);
    truncated = true;
  }
  return {
    channel: ch ? { name: where(ch), id: ch.id, type: ch.type, url: ch.url } : { id: channelId },
    count: msgs.length,
    ...(truncated ? { truncated: true, note: 'More messages exist; narrow with since/before/after.' } : {}),
    messages: msgs.map(m => toView(ctx, m)),
    ...(!ctx.contentIntent || looksContentless(ctx, msgs) ? { warning: CONTENT_INTENT_WARNING } : {}),
  };
}

// ── discord_needs_attention ─────────────────────────────────────────────────

type Item = {
  url: string;
  author: string;
  at: string;
  text: string;
  reasons: string[];
  /** You posted in this channel/thread after it (likely handled). */
  handled: boolean;
  replyTo?: MessageView['replyTo'];
};

type Flagged = { url: string; at: string; channel: string; note: string; context?: { author: string; text: string; url: string; at: string } };

function item(ctx: GuildContext, m: RawMessage, reasons: string[], handled: boolean): Item {
  const v = toView(ctx, m);
  return {
    url: v.url,
    author: v.author,
    at: v.at,
    text: excerpt(renderContent(ctx, m) || (m.attachments.length ? `[${m.attachments.map(a => a.filename).join(', ')}]` : '(no text)'), 300),
    reasons,
    handled,
    ...(v.replyTo ? { replyTo: v.replyTo } : {}),
  };
}

export async function needsAttention(opts: { since?: Date; maxChannels?: number } = {}) {
  const ctx = await guildContext();
  const since = opts.since ?? previousWorkdayStart();
  const sinceIso = since.toISOString();
  const maxChannels = Math.min(Math.max(opts.maxChannels ?? 25, 1), 50);
  const b = budget(TIME_BUDGET_MS);

  const moved = ctx.channels.filter(c => c.lastActivity && c.lastActivity >= sinceIso);
  const noAccess = moved.filter(c => !c.canRead).map(where);
  const readable = moved.filter(c => c.canRead).sort((a, b2) => (b2.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  const toScan = readable.slice(0, maxChannels);
  const capped = readable.slice(maxChannels).map(where);

  const flagged: Flagged[] = [];
  const needsYou: { channel: string; url: string; items: Item[] }[] = [];
  const myThreads: { thread: string; url: string; newMessages: number; from: string[]; latest: string; handled: boolean }[] = [];
  const errors: string[] = [];
  let contentless = false;

  const { skipped } = await mapWithBudget(toScan, b, async ch => {
    let msgs: RawMessage[];
    let truncated = false;
    try {
      ({ messages: msgs, truncated } = await fetchMessages(ch.id, { since, maxPages: 2, budget: b }));
    } catch (e) {
      if (e instanceof DiscordError && e.status === 403) noAccess.push(where(ch));
      else errors.push(`${where(ch)}: ${e instanceof Error ? e.message : 'failed'}`);
      return;
    }
    if (looksContentless(ctx, msgs)) contentless = true;
    const lastMine = msgs.reduce<bigint>((acc, m) => (m.author.id === ctx.ownerId && BigInt(m.id) > acc ? BigInt(m.id) : acc), 0n);
    const handledAfter = (m: RawMessage) => lastMine > BigInt(m.id);

    const items: Item[] = [];
    for (const m of msgs) {
      // Part C: my own messages that tag the bot are "flag for later".
      if (m.author.id === ctx.ownerId && mentionsBot(ctx, m)) {
        const ref = m.referenced_message;
        flagged.push({
          url: toView(ctx, m).url,
          at: m.timestamp,
          channel: where(ch),
          note: excerpt(m.content.replace(/<@!?\d+>|<@&\d+>/g, '').trim() ? renderContent(ctx, { ...m, content: m.content.replace(new RegExp(`<@!?${ctx.botId}>`, 'g'), '') }).trim() : '(just the tag)', 300),
          ...(ref
            ? { context: { author: toView(ctx, ref).author, text: excerpt(renderContent(ctx, ref), 400), url: toView(ctx, ref).url, at: ref.timestamp } }
            : {}),
        });
        continue;
      }
      if (m.author.id === ctx.ownerId || m.author.bot) continue;
      const reasons: string[] = [];
      if (m.mentions.some(u => u.id === ctx.ownerId)) reasons.push('mentions you');
      else if (mentionsMe(ctx, m)) reasons.push('mentions your role');
      if (m.mention_everyone) reasons.push(/@here/.test(m.content) ? '@here' : '@everyone');
      if (m.referenced_message?.author.id === ctx.ownerId) reasons.push('reply to you');
      if (reasons.length) items.push(item(ctx, m, reasons, handledAfter(m)));
    }
    if (items.length) needsYou.push({ channel: where(ch), url: ch.url, items });
    if (truncated) errors.push(`${where(ch)}: busy channel, only the first 200 messages since the cutoff were checked`);

    // New activity in threads you're part of (posted in before or during the window).
    if (ch.isThread && !items.length) {
      const others = msgs.filter(m => m.author.id !== ctx.ownerId && !m.author.bot);
      if (others.length && (lastMine > 0n || (await ownerInThread(ctx, ch.id, b)))) {
        const last = others[others.length - 1];
        myThreads.push({
          thread: where(ch),
          url: ch.url,
          newMessages: others.length,
          from: [...new Set(others.map(m => toView(ctx, m).author))],
          latest: excerpt(`${toView(ctx, last).author}: ${renderContent(ctx, last)}`, 200),
          handled: lastMine > BigInt(last.id),
        });
      }
    }
  });

  const byTime = (a: { at: string }, c: { at: string }) => a.at.localeCompare(c.at);
  flagged.sort(byTime);
  for (const g of needsYou) g.items.sort(byTime);
  needsYou.sort((a, c) => Number(a.items.every(i => i.handled)) - Number(c.items.every(i => i.handled)));

  const warnings: string[] = [];
  if (!ctx.contentIntent || contentless) warnings.push(CONTENT_INTENT_WARNING);
  if (capped.length) warnings.push(`Capped at ${maxChannels} most-active channels; not scanned: ${capped.join(', ')}. Raise max_channels or read them with discord_read_messages.`);
  if (skipped.length) warnings.push(`Ran out of time; not scanned: ${skipped.map(where).join(', ')}.`);
  if (noAccess.length) warnings.push(`The bot can't read: ${[...new Set(noAccess)].join(', ')}.`);

  return {
    since: sinceIso,
    timezone: APP_TZ,
    flaggedForLater: flagged,
    needsYou,
    activeThreadsYouAreIn: myThreads,
    summary: {
      flagged: flagged.length,
      needsYou: needsYou.reduce((n, g) => n + g.items.length, 0),
      unhandled: needsYou.reduce((n, g) => n + g.items.filter(i => !i.handled).length, 0),
      threadsWithNewActivity: myThreads.length,
      channelsActive: moved.length,
      channelsScanned: toScan.length - skipped.length,
    },
    ...(warnings.length ? { warnings } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

// ── discord_message_to_task ─────────────────────────────────────────────────

export async function messageToTask(
  s: Scope,
  ref: { link?: string; channel?: string; messageId?: string },
  overrides: MessageTaskOverrides,
  actor: Actor,
): Promise<MessageTaskResult & { message: { url: string; author: string; at: string } }> {
  const ctx = await guildContext();
  let channelId: string | undefined;
  let messageId = ref.messageId;
  if (ref.link) {
    const p = parseMessageLink(ref.link);
    if (!p) throw new InputError('Could not read that message link; expected https://discord.com/channels/<guild>/<channel>/<message>.');
    channelId = p.channelId;
    messageId = p.messageId;
  } else if (ref.channel) {
    channelId = findChannel(ctx, ref.channel)?.id ?? (/^\d{15,22}$/.test(ref.channel) ? ref.channel : undefined);
  }
  if (!channelId || !messageId) throw new InputError('Give either message_link, or channel + message_id.');
  await assertNotBlocked(ctx, channelId);
  let m: RawMessage;
  try {
    m = await fetchMessage(channelId, messageId, budget(15_000));
  } catch (e) {
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) throw new NotFoundError(`Message not found or not readable (${e.status}).`);
    throw e;
  }
  const res = await taskFromMessage(s, m, { guildId: ctx.guildId, channel: findChannel(ctx, channelId) }, actor, overrides);
  const v = toView(ctx, m);
  return { ...res, message: { url: v.url, author: v.author, at: snowflakeTime(m.id).toISOString() } };
}
