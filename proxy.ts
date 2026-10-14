import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, bearerToken, checkToken, uiAuthConfigured, uiAuthDisabled, verifySessionValue } from '@/lib/auth';

// Guards every page, server action and API route except /login, /api/mcp, /api/worker
// and /api/discord/interactions (which check their own key / device key / Discord signature). API routes also accept the API key: `Authorization: Bearer <MCP_TOKEN>` or `X-API-Key`.
// Claude Code keys (wos_…, lib/api-keys.ts) are deliberately NOT accepted here: checkToken() is MCP_TOKEN only,
// so those keys open /api/mcp and nothing else.
//
// /login is allowed by exact path only (not /login*). Password, 2FA and passkey
// sign-in are server actions on that page (app/login/actions.ts), so they POST
// to /login and need no other unauthenticated endpoint. /login/reset (exact path) is the
// password-reset page; its action checks the emailed token itself (lib/password-reset.ts).
// Session cookies are also checked against the session generation in Mongo (lib/auth.ts).
export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === '/login' || req.nextUrl.pathname === '/login/reset') return NextResponse.next();
  if (uiAuthDisabled()) return NextResponse.next();

  const isApi = req.nextUrl.pathname.startsWith('/api/');

  if (!uiAuthConfigured()) {
    if (isApi && (await checkToken(bearerToken(req)))) return NextResponse.next();
    return new NextResponse('Auth is not configured: set APP_PASSWORD and SESSION_SECRET.', { status: 503 });
  }

  if (await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (isApi) {
    if (await checkToken(bearerToken(req))) return NextResponse.next();
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next !== '/') url.searchParams.set('next', next);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/mcp|api/discord/interactions|api/cron|api/worker|manifest.webmanifest|icons/|sw.js|offline.html|\\.well-known|robots.txt).*)'],
};
