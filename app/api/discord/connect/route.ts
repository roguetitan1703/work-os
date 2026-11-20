import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/lib/auth';
import { callerFromHeaders } from '@/lib/caller';
import { startConnect } from '@/lib/discord/connect';

// Connect Discord, step one (lib/discord/connect.ts): the signed-in person is sent to Discord's own sign-in; Discord sends them
// back to /api/discord/connect/callback. A GET from a link in Work OS (Settings › Notifications, the Today card). Signed-in
// sessions only (an API key cannot connect a Discord account). Always a 303: to Discord, or back to Settings with one fixed word.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const SETTINGS = '/settings?section=notifications';

export async function GET(req: NextRequest) {
  const base = appBaseUrl() ?? new URL(req.url).origin;
  const found = await callerFromHeaders(req.headers, true);
  const caller = found?.via === 'session' ? found : null; // only a signed-in browser: an API key cannot connect a Discord account
  if (!caller) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(SETTINGS)}`, { status: 303, headers: NO_STORE });
  const r = await startConnect({ userId: caller.userId, orgId: caller.orgId }, base);
  if ('url' in r) return NextResponse.redirect(r.url, { status: 303, headers: NO_STORE });
  return NextResponse.redirect(`${base}${SETTINGS}&discord=${r.outcome}`, { status: 303, headers: NO_STORE });
}
