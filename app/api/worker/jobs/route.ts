import { workerRoute } from '@/lib/worker-route';
import { pollJobs } from '@/lib/data/launcher';

// Worker poll: folder links and pending jobs (docs/launcher.md). Device key checked in workerRoute.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = workerRoute(async d => pollJobs(d.id));
