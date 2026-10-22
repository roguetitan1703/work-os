import { NextResponse } from 'next/server';
import { pruneAlertLog, recordRun, runAlerts, type AlertItem } from '@/lib/alerts';
import { reconcileDispatched } from '@/lib/data/dispatcher';
import { pruneInbox } from '@/lib/notify';
import { allMemberships } from '@/lib/people';
import { timezoneOf } from '@/lib/profile';
import { runWithRequestContext } from '@/lib/request-context';

// Alert check, called every 15 minutes by an external scheduler (cron-job.org).
//   GET/POST /api/cron/alerts   Authorization: Bearer <CRON_SECRET>   (or ?key=<CRON_SECRET>)
//   ?dry=1  → report what would be sent, send nothing
// Runs once per person (every membership), each with their own tasks, settings and devices (docs/multi-user.md).
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
  const dry = url.searchParams.get('dry') === '1';
  let quiet = false;
  let sent = 0;
  const items: AlertItem[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  for (const s of await allMemberships()) {
    // Each person in their own timezone ("today", alert hours, quiet hours).
    const tz = await timezoneOf(s).catch(() => undefined);
    const r = await runWithRequestContext({ userId: s.userId, tz }, async () => {
      // Task dispatcher: requeue a claim that never started, stop one whose computer went silent (docs/dispatcher.md). Their alerts go out in the run below.
      if (!dry) await reconcileDispatched(s, at).catch(e => console.error('[dispatcher] reconcile failed', e instanceof Error ? e.message : e));
      return runAlerts(s, { dryRun: dry, baseUrl, now: at }).catch(e => ({ quiet: false, dryRun: dry, sent: 0, messages: [] as string[], items: [] as AlertItem[], error: e instanceof Error ? e.message : String(e) }));
    });
    quiet ||= r.quiet;
    sent += r.sent;
    items.push(...r.items);
    messages.push(...r.messages);
    if (r.error) errors.push(r.error);
    if (!r.dryRun && !at) await recordRun(s, r.error ? `error: ${r.error}` : r.quiet ? 'quiet hours' : r.items.length ? `sent ${r.items.length} alerts` : 'nothing due');
  }
  if (!dry && new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 15) await Promise.all([pruneAlertLog(), pruneInbox()]);
  const error = errors.length ? errors.join('; ') : undefined;
  return NextResponse.json(
    { quiet, dryRun: dry, alerts: items.length, sent, ...(error ? { error } : {}), ...(dry ? { preview: messages } : {}) },
    { status: error ? 502 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
