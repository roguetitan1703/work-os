import 'server-only';
import { listApiKeys } from '@/lib/api-keys';
import type { Caller } from '@/lib/caller';
import { discordConfig, guildContext } from '@/lib/discord/client';
import { lastRunStatus } from '@/lib/alerts';
import { lastSeen } from '@/lib/notify';
import { fmtAgo } from '@/lib/format';
import type { Level } from './ui';

export type Card = { tab: 'chat' | 'discord' | 'alerts' | 'code'; title: string; level: Level; status: string; facts: string[] };

function timed<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('timed out')), ms))]);
}
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Status cards from the same helpers Settings → Status uses (lastSeen, lastRunStatus, key list, guild context). */
export async function overviewCards(caller: Caller): Promise<{ cards: Card[]; mcpReady: boolean; mcpSeen: string | null }> {
  const [all, seen, alerts, discord] = await Promise.all([
    listApiKeys(caller).catch(() => null),
    lastSeen().catch(() => ({ mcp: null, discord: null })),
    lastRunStatus().catch(() => null),
    discordConfig() ? timed(guildContext()).catch((e: Error) => e) : Promise.resolve(null),
  ]);

  const keys = all?.filter(k => k.agent === 'claude-code') ?? null;
  const chatKeys = all?.filter(k => k.agent === 'claude') ?? [];
  const mcpReady = chatKeys.length > 0;
  const chat: Card = !mcpReady
    ? { tab: 'chat', title: 'Claude chat', level: 'off', status: 'Not set up · no key yet', facts: ['Create a key below, then add the connector on claude.ai'] }
    : seen.mcp
      ? { tab: 'chat', title: 'Claude chat', level: 'ok', status: `Connected · last used ${fmtAgo(seen.mcp)}`, facts: ['claude.ai custom connector'] }
      : { tab: 'chat', title: 'Claude chat', level: 'warn', status: 'Not set up · never used', facts: ['Key is ready; add the connector on claude.ai'] };

  let code: Card;
  if (!keys) code = { tab: 'code', title: 'Claude Code', level: 'error', status: 'Problem: could not read keys', facts: [] };
  else if (keys.length === 0) code = { tab: 'code', title: 'Claude Code', level: 'off', status: 'Not set up', facts: ['No keys yet'] };
  else {
    const used = keys.filter(k => k.lastUsedAt && sameDay(k.lastUsedAt)).length;
    const last = keys.map(k => k.lastUsedAt).filter((x): x is string => !!x).sort().pop();
    code = {
      tab: 'code',
      title: 'Claude Code',
      level: last ? 'ok' : 'warn',
      status: last ? `Connected · last used ${fmtAgo(last)}` : 'Keys created · never used',
      facts: [`${plural(keys.length, 'key')}, ${used} used today`],
    };
  }

  let disc: Card;
  if (!discordConfig()) disc = { tab: 'discord', title: 'Discord bot', level: 'off', status: 'Not set up', facts: ['Discord env vars missing'] };
  else if (discord instanceof Error) disc = { tab: 'discord', title: 'Discord bot', level: 'error', status: `Problem: ${discord.message}`, facts: [] };
  else if (discord)
    disc = {
      tab: 'discord',
      title: 'Discord bot',
      level: discord.contentIntent ? 'ok' : 'warn',
      status: discord.contentIntent ? 'Bot online' : 'Problem: Message Content Intent is off',
      facts: [`${plural(discord.blocked.size, 'channel')} blocked`, seen.discord ? `last command ${fmtAgo(seen.discord)}` : 'no commands used yet'],
    };
  else disc = { tab: 'discord', title: 'Discord bot', level: 'off', status: 'Not set up', facts: [] };

  const cron = process.env.CRON_SECRET;
  let alert: Card;
  if (!cron || cron.length < 16) alert = { tab: 'alerts', title: 'Alerts', level: 'off', status: 'Not set up', facts: ['CRON_SECRET missing'] };
  else if (!alerts?.lastRunAt) alert = { tab: 'alerts', title: 'Alerts', level: 'warn', status: 'Ready · no check has run yet', facts: ['Create the scheduled job'] };
  else
    alert = {
      tab: 'alerts',
      title: 'Alerts',
      level: alerts.stale ? 'warn' : 'ok',
      status: alerts.stale ? 'Problem: checks look stopped' : 'Running',
      facts: [`Last check ${fmtAgo(alerts.lastRunAt)}`, 'Checks every 15 min'],
    };

  return { cards: [chat, code, disc, alert], mcpReady, mcpSeen: seen.mcp };
}
