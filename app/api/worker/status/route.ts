import { after } from 'next/server';
import { headers } from 'next/headers';
import { workerRoute } from '@/lib/worker-route';
import { reportStatus } from '@/lib/data/launcher';
import { settleDispatched } from '@/lib/data/dispatcher';
import { flushQueuedAlerts } from '@/lib/alerts';

// Worker heartbeat: job results and session states (docs/launcher.md). Device key checked in workerRoute.
// A dead or failed session ends a dispatched task's run (docs/dispatcher.md), so settle after the report.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = workerRoute(async (d, body) => {
  await reportStatus(d.id, body);
  try {
    if ((await settleDispatched()) > 0) {
      const h = await headers();
      const host = h.get('x-forwarded-host') ?? h.get('host');
      const base = (process.env.APP_URL || (host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : '')).replace(/\/+$/, '');
      after(() => flushQueuedAlerts(base));
    }
  } catch (e) {
    console.error('[dispatcher]', e instanceof Error ? e.message : e);
  }
  return { ok: true };
}, { body: true });
