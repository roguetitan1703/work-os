import 'server-only';
import { collections } from '@/lib/db';
import { lastRunStatus } from '@/lib/alerts';

/** Claude items waiting on Om (same rule as waitingCounts, summed). Minimal on purpose: the nav badge only. */
export async function claudeWaitingCount(): Promise<number> {
  const c = await collections();
  const r = await c.claudeItems
    .aggregate<{ n: number }>([{ $match: { state: { $in: ['queued', 'active', 'blocked'] }, waitingOnOm: { $nin: ['', null] } } }, { $count: 'n' }])
    .toArray();
  return r[0]?.n ?? 0;
}

export type StatusLevel = 'ok' | 'warn' | 'error';

/** One cheap health level for the Settings dot: required secrets present and the alert checks running. No network calls. */
export async function systemStatusLevel(): Promise<StatusLevel> {
  const token = process.env.MCP_TOKEN;
  if (!token || token.length < 24) return 'error';
  const cron = process.env.CRON_SECRET;
  if (!cron || cron.length < 16) return 'warn';
  const run = await lastRunStatus().catch(() => null);
  if (!run?.lastRunAt || run.stale) return 'warn';
  return 'ok';
}
