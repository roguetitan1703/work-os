import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/lib/auth';
import { callerFromHeaders } from '@/lib/caller';
import { finishConnect } from '@/lib/discord/connect';

// Connect Discord, step two: where Discord sends the browser back (lib/discord/connect.ts). The person must be signed in here,
// and be the one the state was made for. Always a 303 to Settings with one fixed word (linked, failed, notmember, ...): never
// the code or any text from Discord. no-referrer, so the code in this address goes nowhere else.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const SETTINGS = '/settings?section=notifications';

export async function GET(req: NextRequest) {
  const base = appBaseUrl() ?? new URL(req.url).origin;
  const found = await callerFromHeaders(req.headers, true);
  const caller = found?.via === 'session' ? found : null; // only a signed-in browser: an API key cannot connect a Discord account
  if (!caller) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(SETTINGS)}`, { status: 303, headers: NO_STORE });
  const q = req.nextUrl.searchParams;
  const back = (word: string) => NextResponse.redirect(`${base}${SETTINGS}&discord=${word}`, { status: 303, headers: NO_STORE });
  if (q.get('error')) return back('failed'); // the person pressed Cancel at Discord
  const outcome = await finishConnect({ userId: caller.userId, orgId: caller.orgId }, q.get('code') ?? '', q.get('state') ?? '', base);
  return back(outcome);
}
