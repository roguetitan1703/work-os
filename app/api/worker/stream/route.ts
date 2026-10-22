import { workerDevice } from '@/lib/worker-route';
import { liveResponse } from '@/lib/live-stream';

// Push stream for a worker (docs/launcher.md, docs/multi-user.md "As built: phase 5 push"): the same device-key and
// membership check as every /api/worker route. It carries only "poll now" (event jobs); the jobs themselves still come
// from GET /api/worker/jobs, so claims, hand-out and validation stay in one place.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const d = await workerDevice(req);
  if (d instanceof Response) return d;
  return liveResponse(req, { kind: 'worker', orgId: d.s.orgId, userId: d.s.userId, deviceId: d.id });
}
