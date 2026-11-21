import 'server-only';
import { createTask, findTaskBySourceMessage } from '../data/tasks';
import { listProjectsBasic } from '../data/projects';
import { resolveDate, todayStr, addDays } from '../dates';
import { matchMode } from '../quick-parse';
import { getOrgModes } from '../org-modes';
import type { Actor, Mode, Priority, Task, TaskSource, TextAuthor } from '../types';
import type { Scope } from '../scope';
import { authorName, excerpt, jumpLink, type ChannelInfo, type RawMessage } from './client';

// Turns a Discord message into a Work OS task. Used by the bot's own recording (lib/discord/issues.ts: a post in a project's
// channel; lib/discord/track.ts: a message marked with the track emoji). The task belongs to s.

export type MessageTaskOverrides = {
  title?: string;
  project?: string | null;
  mode?: Mode | null;
  priority?: Priority;
  due?: string | null;
  note?: string;
  createProject?: boolean;
  /** Recorded by the bot: a post in a project's channel (issue) or a message marked with the track emoji (emoji). */
  tracked?: 'issue' | 'emoji';
  /** More fields of the task's source (the poster, the reactor). */
  sourceExtra?: { authorId?: string; reactorId?: string };
  /** The Work OS member whose linked Discord account wrote the message: the task's text is theirs, not an outside author's. */
  authorUser?: string;
  /** The attachments' links go on the task (name and url). */
  attachmentLinks?: boolean;
  /** The author as Work OS shows them (the linked person's name); default the Discord display name. */
  authorName?: string;
  /** The title when the message has no text (a screenshot alone). */
  emptyTitle?: string;
  /** No guess of a due date from the words. */
  noDue?: boolean;
  /** Who the task is for (Work OS user ids). */
  assignees?: string[];
};

export type MessageTaskResult = { task: Task; existing: boolean };

/** Plain text of a message: mentions, custom emoji and markdown noise stripped. */
export function plainText(m: Pick<RawMessage, 'content' | 'mentions'>): string {
  const names = new Map(m.mentions.map(u => [u.id, u.global_name || u.username]));
  return m.content
    .replace(/<@!?(\d+)>/g, (_, id) => (names.has(id) ? '@' + names.get(id) : ''))
    .replace(/<@&\d+>|<#\d+>|@everyone|@here/g, '')
    .replace(/<a?:(\w+):\d+>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_~`>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING_FILLER = /^(hey|hi|hello|yo|ok|okay|so|also|btw|fyi|pls|please|can you|could you|would you|can we|could we|we need to|need to|i need to|you need to|remember to|reminder:?|todo:?|to do:?|task:?)\b[\s,:-]*/i;

/** Short, verb-first-ish title from the message: first sentence, filler stripped, ≤ 80 chars. */
export function draftTitle(text: string, empty = 'Follow up on Discord message'): string {
  let t = text.replace(/https?:\/\/\S+/g, '').trim();
  t = t.split(/(?<=[.!?])\s|\n/)[0] ?? t;
  for (let i = 0; i < 3; i++) t = t.replace(LEADING_FILLER, '');
  t = t.replace(/[?.!,;:\s]+$/, '').trim();
  if (!t) return empty;
  t = t[0].toUpperCase() + t.slice(1);
  return t.length > 80 ? t.slice(0, 79).replace(/\s+\S*$/, '') + '…' : t;
}

/** Only an explicit due date: "today", "tomorrow", "EOD", "by friday", "on mon", "due 2026-10-20". */
export function explicitDue(text: string, today = todayStr()): string | null {
  const s = text.toLowerCase();
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && /\b(by|due|before|on|deadline)\b/.test(s)) return iso[1];
  if (/\b(eod|end of (the )?day|by tonight|today)\b/.test(s)) return today;
  if (/\b(tomorrow|tmrw|tmr)\b/.test(s)) return addDays(today, 1);
  const wd = s.match(/\b(?:by|on|before|due|deadline)\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/);
  if (wd) return resolveDate(wd[1], today) ?? null;
  if (/\b(eow|end of (the )?week)\b/.test(s)) return resolveDate('eow', today) ?? null;
  return null;
}

const MODE_HINTS: [RegExp, Mode][] = [
  [/\b(dev|devs|code|bugs?|deploys?|deployments?|backend|frontend|api|github|engineering|tech)\b/, 'Code & Dev'],
  [/\b(clients?|delivery|support|handovers?|projects?)\b/, 'Client Delivery'],
  [/\b(team|interns?|design|content|marketing|reviews?)\b/, 'Team Direction'],
  [/\b(sales|leads?|outreach|fiverr|prospects?|prospecting)\b/, 'Outreach & Sales'],
  [/\b(growth|partnerships?|partners|idex)\b/, 'Growth'],
  [/\b(research|planning|strategy|ideas?)\b/, 'Research & Planning'],
  [/\b(founders?|decisions?)\b/, 'Founder Decisions'],
  [/\b(admin|finance|invoices?|expenses?|accounts|billing|legal|hr)\b/, 'Business Admin'],
];

/** A mode from the channel's name: hints for the default modes the organization has, else the start of a mode's name. */
async function guessMode(s: Scope, channel: string): Promise<Mode | null> {
  const modes = await getOrgModes(s.orgId);
  const text = channel.toLowerCase().replace(/[-_]/g, ' ');
  for (const [re, mode] of MODE_HINTS) if (re.test(text) && modes.some(m => m.name === mode)) return mode;
  return matchMode(text.split(' ')[0], modes) ?? null;
}

async function guessProject(s: Scope, channel: ChannelInfo | undefined, text: string): Promise<string | null> {
  const projects = (await listProjectsBasic(s)).filter(p => p.status === 'active' || p.status === 'paused');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const candidates = [channel?.name, channel?.isThread ? channel?.parentName : null, channel?.category].filter(Boolean) as string[];
  for (const c of candidates) {
    const n = norm(c);
    if (n.length < 3) continue;
    const hit = projects.find(p => {
      const pn = norm(p.name);
      return pn.length >= 3 && (n === pn || n.includes(pn) || pn.includes(n));
    });
    if (hit) return hit.name;
  }
  // Project named in the text (whole word, ≥ 4 chars, to avoid "om"/"az" noise).
  const lower = text.toLowerCase();
  const named = projects.filter(p => p.name.length >= 4).find(p => new RegExp(`\\b${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
  return named?.name ?? null;
}

export async function taskFromMessage(
  s: Scope,
  m: RawMessage,
  ctx: { guildId: string; channel?: ChannelInfo; channelName?: string },
  actor: Actor,
  overrides: MessageTaskOverrides = {},
): Promise<MessageTaskResult> {
  const existing = await findTaskBySourceMessage(s, m.id);
  if (existing) return { task: existing, existing: true };

  const text = plainText(m);
  const channelName = ctx.channel?.name ?? ctx.channelName ?? m.channel_id;
  const url = jumpLink(ctx.guildId, m.channel_id, m.id);
  const author = overrides.authorName ?? authorName(m);
  const where = ctx.channel?.isThread && ctx.channel.parentName ? `#${ctx.channel.parentName} › ${channelName}` : `#${channelName}`;
  const quote = (m.content.trim() ? m.content.trim() : '(no text)').split('\n').map(l => `> ${l}`).join('\n');
  const files = m.attachments.length ? `\n\nAttachments: ${m.attachments.map(a => a.filename).join(', ')}` : '';
  const replyCtx = m.referenced_message ? `\n\nIn reply to ${authorName(m.referenced_message)}: "${excerpt(m.referenced_message.content, 240)}"` : '';

  const source: TaskSource = { kind: 'discord', guildId: ctx.guildId, channelId: m.channel_id, messageId: m.id, url, channelName, author, ...(overrides.tracked ? { tracked: overrides.tracked } : {}), ...(overrides.sourceExtra ?? {}) };
  const msgAuthor: TextAuthor = overrides.authorUser ? { kind: 'user', userId: overrides.authorUser } : { kind: 'discord-author', name: author };
  const task = await createTask(
    s,
    {
      title: overrides.title?.trim() || draftTitle(text, overrides.emptyTitle),
      description: `From Discord, ${author} in ${where} (${m.timestamp.slice(0, 10)}):\n\n${quote}${replyCtx}${files}\n\n${url}`,
      project: overrides.project !== undefined ? overrides.project : await guessProject(s, ctx.channel, text),
      mode: overrides.mode !== undefined ? overrides.mode : await guessMode(s, `${channelName} ${ctx.channel?.parentName ?? ''} ${ctx.channel?.category ?? ''}`),
      priority: overrides.priority ?? 'P2',
      ...(overrides.assignees?.length ? { assignees: overrides.assignees } : {}),
      due: overrides.due !== undefined ? overrides.due : overrides.noDue ? null : explicitDue(text),
      links: [{ url, label: `Discord: ${where}` }, ...(overrides.attachmentLinks ? m.attachments.slice(0, 8).map(a => ({ url: a.url, label: a.filename.slice(0, 80) })) : [])],
    },
    actor,
    {
      note: overrides.note ?? `From Discord message by ${author} in ${where}`,
      createProject: overrides.createProject,
      source,
      // The message's words are its author's, not the member's who made the task (lib/data/authors.ts): a title the
      // member typed is theirs.
      authors: { title: overrides.title?.trim() ? actor : msgAuthor, description: msgAuthor, links: [actor, ...m.attachments.slice(0, 8).map(() => msgAuthor)] },
    },
  );
  return { task, existing: false };
}
