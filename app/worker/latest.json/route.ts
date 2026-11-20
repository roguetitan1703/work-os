import { workerBundle, workerSignature } from '@/lib/worker-bundle';

// Public: which worker release this server serves. A downloaded worker updates itself from it (worker/update.mjs) when
// the version is newer and `signature` (absent when the release is not signed) verifies with a key in its own code.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const b = workerBundle();
  const signature = workerSignature(b);
  return Response.json({ version: b.version, sha256: b.sha256, bytes: b.bytes, ...(signature ? { signature } : {}) }, { headers: { 'cache-control': 'no-cache' } });
}
