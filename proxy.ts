import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, bearerToken, checkToken, uiAuthConfigured, uiAuthDisabled, verifySessionValue } from '@/lib/auth';

// Guards every page, server action and API route except /login and /api/mcp
// (which checks its own token). API routes also accept `Authorization: Bearer <MCP_TOKEN>`.
export async function proxy(req: NextRequest) {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|api/mcp|\\.well-known|robots.txt).*)'],
};
