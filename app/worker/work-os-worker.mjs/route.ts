import { workerBundle } from '@/lib/worker-bundle';

// Public on purpose (the install command downloads it before any key exists): the worker's source, nothing else.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const b = workerBundle();
  const etag = `"${b.sha256}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(b.body, { headers: { 'content-type': 'text/javascript; charset=utf-8', etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
}
