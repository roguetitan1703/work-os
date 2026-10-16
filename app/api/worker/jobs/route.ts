import { after } from 'next/server';
import { headers } from 'next/headers';
import { workerRoute } from '@/lib/worker-route';
import { pollJobs } from '@/lib/data/launcher';
import { dispatchFor } from '@/lib/data/dispatcher';
import { flushQueuedAlerts } from '@/lib/alerts';

// Worker poll: folder links and pending jobs (docs/launcher.md). Device key checked in workerRoute.
// Before the jobs are read, the dispatcher may claim a queued task for this computer (docs/dispatcher.md);
// its start job then comes back in this same response. A dispatcher error never blocks the worker's poll.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = workerRoute(async d => {
  try {
    await dispatchFor(d.id);
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    const base = (process.env.APP_URL || (host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : '')).replace(/\/+$/, '');
    after(() => flushQueuedAlerts(base)); // a finished or stopped task queued an alert
  } catch (e) {
    console.error('[dispatcher]', e instanceof Error ? e.message : e);
  }
  return pollJobs(d.id);
});
