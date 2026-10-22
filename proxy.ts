import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { getCookieCache } from 'better-auth/cookies';
import { COOKIE_PREFIX, authSecret, bearerToken, secureCookies } from '@/lib/auth';
import { recordRequest, requestCaller, requestKind, routePattern } from '@/lib/usage';

// Guards every page, server action and API route (docs/auth.md). Sign-in is Better Auth (lib/auth-server.ts).
//
// Cheap on purpose: a signed-in browser carries a signed copy of its session (Better Auth's cookie cache,
// COOKIE_CACHE_SECONDS); while it is fresh the proxy checks only its signature, with no database read. When it has
// run out, the session is read once (auth.api.getSession) and the refreshed copy goes back to the browser. Pages,
// actions and routes then ask lib/caller.ts who is calling; this check is the first gate, not the only one.
//
// Public: /login, /login/reset (exact paths), /accept-invitation/<id> and Better Auth's endpoints under /api/auth
// (app/api/auth/[...all]/route.ts serves only an allowlist of them, each checking its own session).
// /api/mcp, /api/worker, /api/cron and /api/discord/interactions check their own credentials (API key, device key,
// cron secret, Discord signature): the proxy lets them through untouched, as before.
// Other /api routes also accept a Claude chat key (`Authorization: Bearer wos_…` or `X-API-Key`), verified here and
// again by the route. Claude Code keys open /api/mcp only.
//
// Every request that reaches the proxy is also counted for Settings › Usage (lib/usage.ts, docs/usage-log.md),
// after the response (event.waitUntil); counting never changes or delays the answer.

// Paths that skip the session check and check their own credentials (same prefix test the old matcher made).
const SELF_AUTH_PREFIXES = ['/api/mcp', '/api/discord/interactions', '/api/cron', '/api/worker', '/api/auth'];
const selfAuth = (pathname: string) => SELF_AUTH_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
const isPublicPage = (p: string) => p === '/login' || p === '/login/reset' || /^\/accept-invitation\/[A-Za-z0-9_-]{1,64}$/.test(p);

const sessionCookieName = () => `${secureCookies() ? '__Secure-' : ''}${COOKIE_PREFIX}.session_token`;

type Guarded = { res: NextResponse; session: boolean; token: boolean };
const deny = (res: NextResponse): Guarded => ({ res, session: false, token: false });
const pass = (session: boolean, token = false): Guarded => ({ res: NextResponse.next(), session, token });

/** Session read from the database (cookie cache missing or stale). Returns the response carrying the refreshed cookies. */
async function fullSessionCheck(req: NextRequest): Promise<NextResponse | null> {
  try {
    const { getAuth } = await import('@/lib/auth-server');
    const auth = await getAuth();
    const r = await auth.api.getSession({ headers: req.headers, returnHeaders: true });
    if (!r.response?.session) return null;
    const { splitSetCookieHeader, parseSetCookieHeader } = await import('better-auth/cookies');
    const raw = r.headers.get('set-cookie');
    if (!raw) return NextResponse.next();
    // The page behind this request reads the refreshed copy too, so it needs no second database read.
    for (const [name, c] of parseSetCookieHeader(raw)) {
      if (c['max-age'] === 0 || !c.value) req.cookies.delete(name);
      else req.cookies.set(name, c.value);
    }
    const res = NextResponse.next({ request: { headers: req.headers } });
    for (const one of splitSetCookieHeader(raw)) res.headers.append('set-cookie', one);
    return res;
  } catch (e) {
    console.error('session check failed', e); // fail closed
    return null;
  }
}

async function guard(req: NextRequest): Promise<Guarded> {
  const path = req.nextUrl.pathname;
  if (selfAuth(path)) return pass(false);
  if (isPublicPage(path)) return pass(!!req.cookies.get(sessionCookieName())?.value);

  const isApi = path.startsWith('/api/');
  const secret = authSecret();
  if (!secret) return deny(new NextResponse('Auth is not configured: set BETTER_AUTH_SECRET (32+ characters) and APP_URL.', { status: 503 }));

  if (req.cookies.get(sessionCookieName())?.value) {
    const cached = await getCookieCache(req, { cookiePrefix: COOKIE_PREFIX, isSecure: secureCookies(), secret }).catch(() => null);
    if (cached?.session && cached.user) return pass(true);
    const res = await fullSessionCheck(req);
    if (res) return { res, session: true, token: false };
  }

  if (isApi) {
    const token = bearerToken(req);
    if (token) {
      const { verifyKey } = await import('@/lib/caller');
      if (await verifyKey(token, ['claude']).catch(() => null)) return pass(false, true);
    }
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
// the proxy and are not counted. Neither does the liveness route /api/live (that exact path: nginx, systemd and the
// deploy script poll it; app/api/live/route.ts). The self-authenticating API routes are matched (for the count) and let
// through in guard().
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|sw.js|offline.html|\\.well-known|robots.txt|api/live$).*)'],
};
