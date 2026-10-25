import { workerBundle } from '@/lib/worker-bundle';

// Public: which worker bundle this release serves (the worker asks it to tell its person an update exists).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const b = workerBundle();
  return Response.json({ version: b.version, sha256: b.sha256, bytes: b.bytes }, { headers: { 'cache-control': 'no-cache' } });
}
