import { workerRoute } from '@/lib/worker-route';
import { reportStatus } from '@/lib/data/launcher';

// Worker heartbeat: job results and session states (docs/launcher.md). Device key checked in workerRoute.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = workerRoute(async (d, body) => {
  await reportStatus(d.id, body);
  return { ok: true };
}, { body: true });
