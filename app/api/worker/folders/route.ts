import { workerRoute } from '@/lib/worker-route';
import { reportFolders } from '@/lib/data/launcher';

// Worker scan report (docs/launcher.md). Excluded from proxy.ts; device key checked in workerRoute.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = workerRoute(async (d, body) => ({ ok: true, ...(await reportFolders(d.s, d.id, body)) }), { body: true });
