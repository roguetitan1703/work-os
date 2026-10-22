import 'server-only';
import { getOrgSetting, setOrgSetting } from '../scope';

// Read-only Discord REST client used by the MCP tools and the interactions endpoint.
// No gateway, no storage: everything is fetched on demand with the bot token.
//
//   DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY   one bot for the deployment
//   discord:<orgId>.guildId                                          each organization's server (set by the operator)
//   profile:<userId>.discordId                                       each person's own account (lib/profile.ts, /link)
//
// Reads are made for one person in one organization's server, and only show what that person's Discord account can
// see there (their roles and the channel permissions), minus the organization's blocked channels.
// The token never leaves this module: errors carry only status + route + Discord's message.

// DISCORD_API_BASE is only for local tests against a fake API.
const API = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
/** Discord's API root (the interaction webhooks too). */
export const API_BASE = API;
const DISCORD_EPOCH = 1420070400000n;

export const CHANNEL_TYPES: Record<number, string> = {
  0: 'text',
  2: 'voice',
  4: 'category',
  5: 'announcement',
  10: 'announcement-thread',
  11: 'thread',
  12: 'private-thread',
  13: 'stage',
  15: 'forum',
  16: 'media',
};
const READABLE = new Set([0, 2, 5, 10, 11, 12, 13]);
const THREAD_TYPES = new Set([10, 11, 12]);

const PERM = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};

// ── Config ──────────────────────────────────────────────────────────────────

export type DiscordConfig = { token: string; appId: string; publicKey: string };

/** The deployment's bot, or null when it is not set up. */
export function discordConfig(): DiscordConfig | null {
  const c = {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
    appId: process.env.DISCORD_APPLICATION_ID ?? '',
    publicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
  };
  return c.token ? c : null;
}

export function requireConfig(): DiscordConfig {
  const c = discordConfig();
  if (!c) throw new DiscordError('Discord is not configured: set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY.', 0, '');
  return c;
}

/** One person's Discord in one organization: the organization's server and their linked account (null: not linked). */
export type DiscordLink = { orgId: string; guildId: string; discordId: string | null };

const SNOWFLAKE = /^\d{15,22}$/;

/** The organization's Discord server id, or null. */
export async function orgGuildId(orgId: string): Promise<string | null> {
  const g = (await getOrgSetting(orgId, 'discord'))?.guildId;
  return typeof g === 'string' && SNOWFLAKE.test(g) ? g : null;
}

/** The operator sets which Discord server belongs to an organization (one organization per server: unique index). */
export async function setOrgGuildId(orgId: string, guildId: string | null): Promise<void> {
  if (guildId !== null && !SNOWFLAKE.test(guildId)) throw new DiscordError('A server id is 15 to 22 digits.', 0, '');
  await setOrgSetting(orgId, 'discord', { guildId, updatedAt: new Date() });
  forget(orgId);
}

export class DiscordError extends Error {
  constructor(
    message: string,
    public status: number,
    public route: string,
  ) {
    super(message);
    this.name = 'DiscordError';
  }
}

// ── Snowflakes ──────────────────────────────────────────────────────────────

export function snowflakeTime(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** Smallest snowflake at or after this instant — use as `after=` to fetch messages since then. */
export function snowflakeAt(date: Date): string {
  const ms = BigInt(Math.max(date.getTime(), Number(DISCORD_EPOCH)));
  return (((ms - DISCORD_EPOCH) << 22n) - 1n).toString();
}

export function jumpLink(guildId: string, channelId: string, messageId?: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}${messageId ? '/' + messageId : ''}`;
}

/** Accepts a jump link or "channelId/messageId". */
export function parseMessageLink(s: string): { channelId: string; messageId: string } | null {
  const m = s.match(/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/) ?? s.match(/^(\d{15,22})[/:](\d{15,22})$/);
  return m ? { channelId: m[1], messageId: m[2] } : null;
}

// ── Request layer: limited concurrency, 429 handling, deadline ─────────────

const MAX_CONCURRENCY = 4;
let active = 0;
const queue: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) await new Promise<void>(r => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export type Budget = { deadline: number };
export const budget = (ms: number): Budget => ({ deadline: Date.now() + ms });
export const timeLeft = (b?: Budget) => (b ? b.deadline - Date.now() : Infinity);

export async function api<T>(route: string, opts: { method?: string; body?: unknown; budget?: Budget; token?: 'bot' | 'none' } = {}): Promise<T> {
  const cfg = requireConfig();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (timeLeft(opts.budget) < 500) throw new DiscordError('time budget exhausted', 0, route);
    const res = await slot(() =>
      fetch(API + route, {
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token === 'none' ? {} : { Authorization: `Bot ${cfg.token}` }),
          'User-Agent': 'DiscordBot (https://github.com/roguetitan1703/work-os, 1.0)',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      }),
    );
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.ceil((body.retry_after ?? Number(res.headers.get('retry-after') ?? 1)) * 1000) + 50;
      if (wait > timeLeft(opts.budget) - 500 || wait > 10_000) throw new DiscordError(`rate limited (retry after ${wait}ms)`, 429, route);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data as { message?: string } | null)?.message ?? res.statusText;
      throw new DiscordError(`Discord ${res.status} on ${route.split('?')[0]}: ${msg}`, res.status, route);
    }
    return data as T;
  }
  throw new DiscordError('rate limited repeatedly', 429, route);
}

/** Run fn over items with the shared concurrency limit, stopping when the budget runs low. */
export async function mapWithBudget<I, O>(items: I[], b: Budget, fn: (i: I) => Promise<O>): Promise<{ results: O[]; skipped: I[] }> {
  const results: O[] = [];
  const skipped: I[] = [];
  await Promise.all(
    items.map(async it => {
      if (timeLeft(b) < 2000) return void skipped.push(it);
      results.push(await fn(it));
    }),
  );
  return { results, skipped };
}

// ── Raw shapes (subset) ─────────────────────────────────────────────────────

export type RawUser = { id: string; username: string; global_name?: string | null; bot?: boolean };
export type RawOverwrite = { id: string; type: 0 | 1; allow: string; deny: string };
export type RawChannel = {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  position?: number;
  last_message_id?: string | null;
  permission_overwrites?: RawOverwrite[];
  thread_metadata?: { archived: boolean; locked?: boolean };
  owner_id?: string;
  message_count?: number;
};
export type RawRole = { id: string; name: string; permissions: string; managed?: boolean; tags?: { bot_id?: string } };
export type RawMember = { user?: RawUser; roles: string[]; nick?: string | null };
export type RawMessage = {
  id: string;
  channel_id: string;
  type: number;
  author: RawUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  mentions: RawUser[];
  mention_roles: string[];
  mention_everyone: boolean;
  attachments: { filename: string; url: string; size: number }[];
  embeds: unknown[];
  sticker_items?: unknown[];
  message_reference?: { message_id?: string; channel_id?: string };
  referenced_message?: RawMessage | null;
  thread?: RawChannel;
};

// ── Guild context (cached ~90s) ─────────────────────────────────────────────

export type ChannelInfo = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  parentName: string | null; // category for channels, parent channel for threads
  category: string | null;
  isThread: boolean;
  lastActivity: string | null; // ISO, from last_message_id
  archived?: boolean;
  canRead: boolean;
  url: string;
};

export type GuildContext = {
  orgId: string;
  guildId: string;
  botId: string;
  botRoleIds: string[];
  /** The person the reads are for: their Discord account, name in the server and roles ('' when not linked). */
  ownerId: string;
  ownerName: string;
  ownerRoleIds: string[];
  /** Their account has Administrator (or owns the server): sees every channel, private threads included. */
  ownerAdmin: boolean;
  roleNames: Map<string, string>;
  contentIntent: boolean;
  /**
   * Readable types + threads that the person can view, incl. ones the bot can't read (canRead=false); blocked ones
   * removed. Private threads only for an administrator (membership is not known without a call per thread).
   */
  channels: ChannelInfo[];
  /** Channel and category ids the person can view (for links to channels not in the list, e.g. archived threads). */
  visible: Set<string>;
  /** Every guild channel incl. categories and blocked ones, for the settings UI. */
  layout: { id: string; name: string; type: string; parentId: string | null; blocked: boolean }[];
  /** Ids blocked in settings (channels, categories or threads) and every channel/thread under them. */
  blocked: Set<string>;
  myThreadIds: Set<string>; // active threads the owner is known to be in (filled lazily)
  fetchedAt: number;
};

const CACHE_MS = 90_000;
type Entry = { ctx?: GuildContext; pending?: Promise<GuildContext> };
const g = globalThis as unknown as { __workosDiscord?: Map<string, Entry> };
/** Per organization, server and person. */
const cache = (g.__workosDiscord ??= new Map());
const cacheKey = (l: DiscordLink) => `${l.orgId}:${l.guildId}:${l.discordId ?? ''}`;
function forget(orgId: string) {
  for (const k of cache.keys()) if (k.startsWith(`${orgId}:`)) cache.delete(k);
}

function computePerms(ch: RawChannel, everyone: RawRole | undefined, roles: Map<string, RawRole>, memberRoles: string[], memberId: string): bigint {
  let base = BigInt(everyone?.permissions ?? '0');
  for (const r of memberRoles) base |= BigInt(roles.get(r)?.permissions ?? '0');
  if (base & PERM.ADMINISTRATOR) return ~0n;
  const ow = ch.permission_overwrites ?? [];
  const evOw = ow.find(o => o.id === everyone?.id);
  if (evOw) base = (base & ~BigInt(evOw.deny)) | BigInt(evOw.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ow) if (o.type === 0 && memberRoles.includes(o.id)) {
    allow |= BigInt(o.allow);
    deny |= BigInt(o.deny);
  }
  base = (base & ~deny) | allow;
  const memOw = ow.find(o => o.type === 1 && o.id === memberId);
  if (memOw) base = (base & ~BigInt(memOw.deny)) | BigInt(memOw.allow);
  return base;
}

async function loadContext(link: DiscordLink): Promise<GuildContext> {
  const guildId = link.guildId;
  const b = budget(15_000);
  const [me, app, guild, channels, threads, roles, owner, blockedRoots] = await Promise.all([
    api<RawUser>('/users/@me', { budget: b }),
    api<{ flags?: number }>('/applications/@me', { budget: b }).catch(() => ({ flags: undefined })),
    api<{ owner_id?: string }>(`/guilds/${guildId}`, { budget: b }).catch(() => ({ owner_id: undefined })),
    api<RawChannel[]>(`/guilds/${guildId}/channels`, { budget: b }),
    api<{ threads: RawChannel[] }>(`/guilds/${guildId}/threads/active`, { budget: b }),
    api<RawRole[]>(`/guilds/${guildId}/roles`, { budget: b }),
    link.discordId ? api<RawMember>(`/guilds/${guildId}/members/${link.discordId}`, { budget: b }).catch(() => null) : Promise.resolve(null),
    blockedIds(link.orgId),
  ]);
  const botMember = await api<RawMember>(`/guilds/${guildId}/members/${me.id}`, { budget: b });
  const roleMap = new Map(roles.map(r => [r.id, r]));
  const everyone = roleMap.get(guildId);
  const byId = new Map(channels.map(c => [c.id, c]));

  // What the person can read: computed like the bot's permissions, from their own roles (View Channel and Read Message
  // History; a category needs only View). No account (not linked, or not in the server) sees nothing.
  const ownerAdmin = !!owner && !!link.discordId && (guild.owner_id === link.discordId || computePerms({ id: '', type: 0 }, everyone, roleMap, owner.roles, link.discordId) === ~0n);
  const personCanView = (permSource: RawChannel): boolean => {
    if (!owner || !link.discordId) return false;
    if (ownerAdmin) return true;
    const perms = computePerms(permSource, everyone, roleMap, owner.roles, link.discordId);
    const need = permSource.type === 4 ? PERM.VIEW_CHANNEL : PERM.VIEW_CHANNEL | PERM.READ_MESSAGE_HISTORY;
    return (perms & need) === need;
  };
  const visible = new Set<string>();
  for (const c of channels) if (personCanView(c)) visible.add(c.id);

  const toInfo = (c: RawChannel, permSource: RawChannel): ChannelInfo => {
    const perms = computePerms(permSource, everyone, roleMap, botMember.roles, me.id);
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    const isThread = THREAD_TYPES.has(c.type);
    const categoryId = isThread ? parent?.parent_id : c.parent_id;
    return {
      id: c.id,
      name: c.name ?? c.id,
      type: CHANNEL_TYPES[c.type] ?? `type-${c.type}`,
      parentId: c.parent_id ?? null,
      parentName: parent?.name ?? null,
      category: categoryId ? (byId.get(categoryId)?.name ?? null) : null,
      isThread,
      lastActivity: c.last_message_id ? snowflakeTime(c.last_message_id).toISOString() : null,
      ...(isThread ? { archived: !!c.thread_metadata?.archived } : {}),
      canRead: (perms & PERM.VIEW_CHANNEL) !== 0n && (perms & PERM.READ_MESSAGE_HISTORY) !== 0n,
      url: jumpLink(guildId, c.id),
    };
  };

  // A channel is blocked if it, its category, or (for threads) its parent channel or that channel's category is blocked.
  const blocked = new Set<string>();
  const isBlocked = (c: RawChannel): boolean => {
    if (blockedRoots.has(c.id)) return true;
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    if (c.parent_id && blockedRoots.has(c.parent_id)) return true;
    return !!parent?.parent_id && blockedRoots.has(parent.parent_id);
  };
  const infos: ChannelInfo[] = [];
  for (const c of channels) {
    if (!READABLE.has(c.type)) continue;
    if (isBlocked(c)) blocked.add(c.id);
    else if (visible.has(c.id)) infos.push(toInfo(c, c));
  }
  for (const t of threads.threads) {
    const parent = t.parent_id ? byId.get(t.parent_id) : undefined;
    if (isBlocked(t)) blocked.add(t.id);
    else if (parent && visible.has(parent.id) && (t.type !== 12 || ownerAdmin)) {
      infos.push(toInfo(t, parent));
      visible.add(t.id);
    }
  }
  for (const id of blockedRoots) blocked.add(id);
  const layout = channels
    .filter(c => c.type === 4 || READABLE.has(c.type))
    .sort((a, c) => (a.position ?? 0) - (c.position ?? 0))
    .map(c => ({ id: c.id, name: c.name ?? c.id, type: CHANNEL_TYPES[c.type] ?? String(c.type), parentId: c.parent_id ?? null, blocked: blockedRoots.has(c.id) }));

  // GATEWAY_MESSAGE_CONTENT (1<<19) or _LIMITED (1<<18)
  const flags = app.flags;
  const contentIntent = flags === undefined ? true : (flags & ((1 << 19) | (1 << 18))) !== 0;

  return {
    orgId: link.orgId,
    guildId,
    botId: me.id,
    botRoleIds: roles.filter(r => r.tags?.bot_id === me.id).map(r => r.id),
    ownerId: link.discordId ?? '',
    ownerName: owner?.nick || owner?.user?.global_name || owner?.user?.username || 'you',
    ownerRoleIds: owner?.roles ?? [],
    ownerAdmin,
    roleNames: new Map(roles.map(r => [r.id, r.name])),
    contentIntent,
    channels: infos,
    visible,
    layout,
    blocked,
    myThreadIds: new Set(),
    fetchedAt: Date.now(),
  };
}

// ── Blocked channels (sensitive: passwords etc.) ────────────────────────────
// Stored per organization (settings._id = 'discord:<orgId>'), editable in Settings › Connections by its owners and
// admins; DISCORD_BLOCKED_CHANNELS (comma-separated ids) adds more from env. Blocked channels never reach any tool or
// command.

async function blockedIds(orgId: string): Promise<Set<string>> {
  const fromEnv = (process.env.DISCORD_BLOCKED_CHANNELS ?? '').split(/[\s,]+/).filter(s => SNOWFLAKE.test(s));
  const doc = await getOrgSetting(orgId, 'discord');
  return new Set([...fromEnv, ...(doc?.blockedIds ?? [])]);
}

/** The channels and categories a person is shown in the blocked-channel picker (only what they can see). */
export const pickerLayout = (ctx: GuildContext) => ctx.layout.filter(r => ctx.visible.has(r.id));

/**
 * Save the blocked list as one person picked it. They only see (and submit) the channels their Discord account can
 * see, so everything else stays as it was: new = what they ticked among their picker ∪ (old − their picker). Threads
 * and channels hidden from them are never dropped.
 */
export async function saveBlockedAs(link: DiscordLink, ids: string[]): Promise<void> {
  const ctx = await guildContext(link, { fresh: true });
  const shown = new Set(pickerLayout(ctx).map(r => r.id));
  const old: string[] = (await getOrgSetting(link.orgId, 'discord'))?.blockedIds ?? [];
  await setBlockedIds(link.orgId, [...ids.filter(id => shown.has(id)), ...old.filter(id => !shown.has(id))]);
}

export async function setBlockedIds(orgId: string, ids: string[]): Promise<void> {
  const clean = [...new Set(ids.filter(s => SNOWFLAKE.test(s)))];
  await setOrgSetting(orgId, 'discord', { blockedIds: clean, updatedAt: new Date() });
  forget(orgId);
}

export class BlockedChannelError extends Error {
  constructor() {
    super('That channel is blocked in Work OS settings (marked sensitive), so it is never read.');
    this.name = 'BlockedChannelError';
  }
}

export class NotVisibleError extends Error {
  constructor() {
    super('Channel not found, or your Discord account cannot see it.');
    this.name = 'NotVisibleError';
  }
}

/**
 * Throws if the channel (or its parent/category, for channels not in the cached list such as archived threads) is
 * blocked, or if the person's Discord account cannot view it. A thread not in the list counts as visible when its
 * parent channel is (a private one only for an administrator); anything else unknown is refused.
 */
export async function assertNotBlocked(ctx: GuildContext, channelId: string, b?: Budget): Promise<void> {
  if (ctx.blocked.has(channelId)) throw new BlockedChannelError();
  if (ctx.channels.some(c => c.id === channelId)) return;
  const ch = await api<RawChannel>(`/channels/${channelId}`, { budget: b }).catch(() => null);
  if (!ch) throw new NotVisibleError();
  if (ch.parent_id && ctx.blocked.has(ch.parent_id)) throw new BlockedChannelError();
  const parent = ch.parent_id ? ctx.layout.find(c => c.id === ch.parent_id) : undefined;
  if (parent?.parentId && ctx.blocked.has(parent.parentId)) throw new BlockedChannelError();
  const isThread = THREAD_TYPES.has(ch.type);
  const ok = isThread ? !!ch.parent_id && ctx.visible.has(ch.parent_id) && (ch.type !== 12 || ctx.ownerAdmin) : ctx.visible.has(ch.id);
  if (!ok) throw new NotVisibleError();
}

/** The server as one person in one organization sees it (cached ~90 s per person). */
export async function guildContext(link: DiscordLink, opts: { fresh?: boolean } = {}): Promise<GuildContext> {
  requireConfig();
  const k = cacheKey(link);
  const e: Entry = cache.get(k) ?? {};
  if (!opts.fresh && e.ctx && Date.now() - e.ctx.fetchedAt < CACHE_MS) return e.ctx;
  if (!e.pending) {
    e.pending = loadContext(link)
      .then(ctx => (e.ctx = ctx))
      .finally(() => (e.pending = undefined));
    if (cache.size > 200) cache.clear();
    cache.set(k, e);
  }
  return e.pending;
}

/** Find a channel/thread by id, #name, name, or jump link. */
export function findChannel(ctx: GuildContext, key: string): ChannelInfo | undefined {
  const s = key.trim();
  const exact = ctx.channels.find(c => c.id === s);
  if (exact) return exact;
  const fromLink = s.match(/channels\/\d+\/(\d+)/)?.[1];
  const id = fromLink ?? (/^\d{15,22}$/.test(s) ? s : null);
  if (id) return ctx.channels.find(c => c.id === id);
  const name = s.replace(/^#/, '').toLowerCase();
  return ctx.channels.find(c => c.name.toLowerCase() === name) ?? ctx.channels.find(c => c.name.toLowerCase().includes(name));
}

// ── Messages ────────────────────────────────────────────────────────────────

export type MessageView = {
  id: string;
  url: string;
  channelId: string;
  author: string;
  authorId: string;
  isMe: boolean;
  isBot: boolean;
  at: string;
  edited?: string;
  content: string;
  mentions?: { users?: string[]; roles?: string[]; everyone?: boolean; me?: boolean; bot?: boolean };
  replyTo?: { id: string; author?: string; isMe?: boolean; excerpt?: string; url: string };
  attachments?: string[];
  embeds?: number;
  thread?: { id: string; name?: string; messageCount?: number; url: string };
};

export function authorName(m: Pick<RawMessage, 'author' | 'member'>): string {
  return m.member?.nick || m.author.global_name || m.author.username;
}

export function excerpt(s: string, n = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Message text with <@id>, <@&role>, <#channel> and custom emoji rendered as readable names. */
export function renderContent(ctx: GuildContext, m: Pick<RawMessage, 'content' | 'mentions'>): string {
  const users = new Map(m.mentions.map(u => [u.id, u.global_name || u.username]));
  return m.content
    .replace(/<@!?(\d+)>/g, (_, id) => (id === ctx.ownerId ? `@${ctx.ownerName}` : `@${users.get(id) ?? 'user'}`))
    .replace(/<@&(\d+)>/g, (_, id) => `@${ctx.roleNames.get(id) ?? 'role'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${ctx.channels.find(c => c.id === id)?.name ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

export function mentionsBot(ctx: GuildContext, m: RawMessage): boolean {
  return m.mentions.some(u => u.id === ctx.botId) || m.mention_roles.some(r => ctx.botRoleIds.includes(r));
}

export function mentionsMe(ctx: GuildContext, m: RawMessage): boolean {
  return m.mentions.some(u => u.id === ctx.ownerId) || m.mention_roles.some(r => ctx.ownerRoleIds.includes(r));
}

export function toView(ctx: GuildContext, m: RawMessage): MessageView {
  const ref = m.referenced_message;
  const v: MessageView = {
    id: m.id,
    url: jumpLink(ctx.guildId, m.channel_id, m.id),
    channelId: m.channel_id,
    author: authorName(m),
    authorId: m.author.id,
    isMe: m.author.id === ctx.ownerId,
    isBot: !!m.author.bot,
    at: m.timestamp,
    content: renderContent(ctx, m),
  };
  if (m.edited_timestamp) v.edited = m.edited_timestamp;
  const users = m.mentions.map(u => (u.id === ctx.ownerId ? `${u.global_name || u.username} (me)` : u.global_name || u.username));
  if (users.length || m.mention_roles.length || m.mention_everyone) {
    v.mentions = {
      ...(users.length ? { users } : {}),
      ...(m.mention_roles.length ? { roles: m.mention_roles.map(r => ctx.roleNames.get(r) ?? r) } : {}),
      ...(m.mention_everyone ? { everyone: true } : {}),
      ...(mentionsMe(ctx, m) ? { me: true } : {}),
      ...(mentionsBot(ctx, m) ? { bot: true } : {}),
    };
  }
  if (m.message_reference?.message_id) {
    v.replyTo = {
      id: m.message_reference.message_id,
      url: jumpLink(ctx.guildId, m.message_reference.channel_id ?? m.channel_id, m.message_reference.message_id),
      ...(ref ? { author: authorName(ref), isMe: ref.author.id === ctx.ownerId, excerpt: excerpt(renderContent(ctx, ref), 200) } : {}),
    };
  }
  if (m.attachments.length) v.attachments = m.attachments.map(a => a.filename);
  if (m.embeds.length) v.embeds = m.embeds.length;
  if (m.thread) v.thread = { id: m.thread.id, name: m.thread.name, messageCount: m.thread.message_count, url: jumpLink(ctx.guildId, m.thread.id) };
  return v;
}

/** Messages (oldest → newest). `since` pages forward with after=; otherwise a single page by before/after/around. */
export async function fetchMessages(
  channelId: string,
  q: { since?: Date; before?: string; after?: string; around?: string; limit?: number; maxPages?: number; budget?: Budget },
): Promise<{ messages: RawMessage[]; truncated: boolean }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  if (q.since || q.after) {
    let after = q.after ?? snowflakeAt(q.since!);
    const out: RawMessage[] = [];
    const maxPages = q.maxPages ?? 3;
    for (let page = 0; page < maxPages; page++) {
      const batch = await api<RawMessage[]>(`/channels/${channelId}/messages?after=${after}&limit=100`, { budget: q.budget });
      batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      out.push(...batch);
      if (batch.length < 100) return { messages: out, truncated: false };
      after = batch[batch.length - 1].id;
    }
    return { messages: out, truncated: true };
  }
  const p = q.before ? `before=${q.before}` : q.around ? `around=${q.around}` : '';
  const batch = await api<RawMessage[]>(`/channels/${channelId}/messages?${p}${p ? '&' : ''}limit=${limit}`, { budget: q.budget });
  batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { messages: batch, truncated: false };
}

export async function fetchMessage(channelId: string, messageId: string, b?: Budget): Promise<RawMessage> {
  return api<RawMessage>(`/channels/${channelId}/messages/${messageId}`, { budget: b });
}

/** Is the owner a member of this thread? (Posting in a thread makes you a member.) */
export async function ownerInThread(ctx: GuildContext, threadId: string, b?: Budget): Promise<boolean> {
  if (ctx.myThreadIds.has(threadId)) return true;
  try {
    await api(`/channels/${threadId}/thread-members/${ctx.ownerId}`, { budget: b });
    ctx.myThreadIds.add(threadId);
    return true;
  } catch {
    return false;
  }
}

/** True when messages by other people came back with empty text and nothing else: Message Content Intent is off. */
export function looksContentless(ctx: GuildContext, msgs: RawMessage[]): boolean {
  const others = msgs.filter(m => m.author.id !== ctx.botId && !m.author.bot && m.type === 0 && !mentionsBot(ctx, m));
  return others.length >= 3 && others.every(m => !m.content && !m.attachments.length && !m.embeds.length && !m.sticker_items?.length);
}

export const CONTENT_INTENT_WARNING =
  'Message Content Intent looks OFF for this bot, so message text comes back empty (except messages that mention the bot). Turn it on: Discord Developer Portal → your app → Bot → Privileged Gateway Intents → Message Content Intent.';
