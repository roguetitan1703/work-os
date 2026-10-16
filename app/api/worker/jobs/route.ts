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
    // Dispatcher off: the poll does nothing else (the worker polls all day; each poll is a function call).
    if (!(await dispatchFor(d.id))) return pollJobs(d.id);
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    const base = (process.env.APP_URL || (host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : '')).replace(/\/+$/, '');
    after(() => flushQueuedAlerts(base)); // a finished, stopped or failed task may have queued an alert
  } catch (e) {
    console.error('[dispatcher]', e instanceof Error ? e.message : e);
  }
  return pollJobs(d.id);
});
