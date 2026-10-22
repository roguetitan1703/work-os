import 'server-only';
import { lastRunStatus } from '@/lib/alerts';
import { authSecret } from '@/lib/auth';

/** Claude items waiting on Om, for the nav badge (one rule, shared with the Claude page). */
export { needsYouCount as claudeWaitingCount } from './claude-overview';

export type StatusLevel = 'ok' | 'warn' | 'error';

/** One cheap health level for the Settings dot: required secrets present and the alert checks running. No network calls. */
export async function systemStatusLevel(): Promise<StatusLevel> {
  if (!authSecret()) return 'error';
  const cron = process.env.CRON_SECRET;
  if (!cron || cron.length < 16) return 'warn';
  const run = await lastRunStatus().catch(() => null);
  if (!run?.lastRunAt || run.stale) return 'warn';
  return 'ok';
}
