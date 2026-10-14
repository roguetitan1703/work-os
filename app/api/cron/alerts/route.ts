import { NextResponse } from 'next/server';
import { pruneAlertLog, runAlerts } from '@/lib/alerts';
import { collections } from '@/lib/db';
import { pruneInbox } from '@/lib/notify';

// Alert check, called every 15 minutes by an external scheduler (cron-job.org).
//   GET/POST /api/cron/alerts   Authorization: Bearer <CRON_SECRET>   (or ?key=<CRON_SECRET>)
//   ?dry=1  → report what would be sent, send nothing
// Excluded from proxy.ts; this secret is the only way in.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const url = new URL(req.url);
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('key') ?? '';
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function handle(req: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const baseUrl = (process.env.APP_URL || url.origin).replace(/\/+$/, '');
  // ?at=<ISO> simulates another time; ignored in production.
  const at = process.env.NODE_ENV !== 'production' && url.searchParams.get('at') ? new Date(url.searchParams.get('at')!) : undefined;
  const r = await runAlerts({ dryRun: url.searchParams.get('dry') === '1', baseUrl, now: at });
  if (!r.dryRun && new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 15) await Promise.all([pruneAlertLog(), pruneInbox()]);
  if (!r.dryRun && !at) {
    const summary = r.error ? `error: ${r.error}` : r.quiet ? 'quiet hours' : r.items.length ? `sent ${r.items.length} alerts` : 'nothing due';
    await (await collections()).settings.updateOne({ _id: 'alerts' }, { $set: { lastRunAt: new Date(), lastResult: summary } }, { upsert: true });
  }
  return NextResponse.json(
    { quiet: r.quiet, dryRun: r.dryRun, alerts: r.items.length, sent: r.sent, ...(r.error ? { error: r.error } : {}), ...(r.dryRun ? { preview: r.messages } : {}) },
    { status: r.error ? 502 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
