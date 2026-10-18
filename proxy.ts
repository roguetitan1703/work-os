import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { SESSION_COOKIE, bearerToken, checkToken, uiAuthConfigured, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { recordRequest, requestCaller, requestKind, routePattern } from '@/lib/usage';

// Guards every page, server action and API route except /login, /api/mcp, /api/worker, /api/cron
// and /api/discord/interactions (which check their own key / device key / cron secret / Discord signature).
// API routes also accept the API key: `Authorization: Bearer <MCP_TOKEN>` or `X-API-Key`.
// Claude Code keys (wos_…, lib/api-keys.ts) are deliberately NOT accepted here: checkToken() is MCP_TOKEN only,
// so those keys open /api/mcp and nothing else.
//
// /login is allowed by exact path only (not /login*). Password, 2FA and passkey
// sign-in are server actions on that page (app/login/actions.ts), so they POST
// to /login and need no other unauthenticated endpoint. /login/reset (exact path) is the
// password-reset page; its action checks the emailed token itself (lib/password-reset.ts).
// Session cookies are also checked against the session generation in Mongo (lib/auth.ts).
//
// Every request that reaches the proxy is also counted for Settings › Usage (lib/usage.ts, docs/usage-log.md),
// after the response (event.waitUntil); counting never changes or delays the answer.

// Paths that skip the session check and check their own credentials. Until the request log, the matcher excluded
// them (`(?!…api/mcp|api/discord/interactions|api/cron|api/worker…)`); the proxy now runs on them only to count
// them, and this is the same prefix test the matcher made, so they behave exactly as before.
const SELF_AUTH_PREFIXES = ['/api/mcp', '/api/discord/interactions', '/api/cron', '/api/worker'];
const selfAuth = (pathname: string) => SELF_AUTH_PREFIXES.some(p => pathname.startsWith(p));

type Guarded = { res: NextResponse; session: boolean; token: boolean };
const deny = (res: NextResponse): Guarded => ({ res, session: false, token: false });
const pass = (session: boolean, token = false): Guarded => ({ res: NextResponse.next(), session, token });

async function guard(req: NextRequest): Promise<Guarded> {
  const path = req.nextUrl.pathname;
  if (selfAuth(path)) return pass(false);
  if (path === '/login' || path === '/login/reset') return pass(!!req.cookies.get(SESSION_COOKIE)?.value);
  if (uiAuthDisabled()) return pass(true);

  const isApi = path.startsWith('/api/');

  if (!uiAuthConfigured()) {
    if (isApi && (await checkToken(bearerToken(req)))) return pass(false, true);
    return deny(new NextResponse('Auth is not configured: set APP_PASSWORD and SESSION_SECRET.', { status: 503 }));
  }

  if (await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value)) return pass(true);

  if (isApi) {
    if (await checkToken(bearerToken(req))) return pass(false, true);
    return deny(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const next = path + req.nextUrl.search;
  if (next !== '/') url.searchParams.set('next', next);
  return deny(NextResponse.redirect(url));
}

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const g = await guard(req);
  if (process.env.USAGE_LOG === 'off') return g.res;
  try {
    const path = req.nextUrl.pathname;
    event.waitUntil(
      recordRequest({
        kind: requestKind(req.method, path, req.headers),
        caller: requestCaller(path, req.headers, req.nextUrl, g),
        route: routePattern(path),
      }),
    );
  } catch {
    // counting must never affect the request
  }
  return g.res;
}

// Static files (_next/static, _next/image, icons, manifest, sw.js, offline.html, robots.txt, .well-known) never reach
// the proxy and are not counted. The self-authenticating API routes are matched (for the count) and let through in guard().
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|sw.js|offline.html|\\.well-known|robots.txt).*)'],
};
