// Liveness for nginx, systemd and the deploy script (docs/hosting.md): answers 200 "ok" while this process serves
// requests. Says nothing else: no database, no version, no configuration. proxy.ts does not see it (not counted,
// no session check). The operator's full report is /api/admin/health.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

export const HEAD = GET;
