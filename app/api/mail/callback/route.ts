import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/lib/auth';
import { callerFromHeaders } from '@/lib/caller';
import { ConnectError, completeConnect, connectEnabled, sessionIdOf } from '@/lib/mail/connect';

// Where Mailloom sends the browser back after the person allowed (or cancelled) Work OS (lib/mail/connect.ts,
// docs/flows/mail-connect.md). The person must be signed in here, in the same organization and session that pressed
// Connect; the state proves it. Always a 303 to Settings with one fixed word (linked, revokefail, denied or error):
// never the code, the key or any text from Mailloom. no-referrer, so the code in this address goes nowhere else.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

const back = (flag: 'linked' | 'revokefail' | 'denied' | 'error') => {
  const u = new URL(`${appBaseUrl() ?? ''}/settings`);
  u.searchParams.set('section', 'connections');
  u.searchParams.set('mail', flag);
  return NextResponse.redirect(u, { status: 303, headers: NO_STORE });
};

export async function GET(req: NextRequest) {
  const caller = await callerFromHeaders(req.headers, true); // a fresh session read: a signed-out session cannot connect
  if (!caller) return NextResponse.redirect(`${appBaseUrl() ?? ''}/login?next=${encodeURIComponent('/settings?section=connections')}`, { status: 303, headers: NO_STORE });
  if (!connectEnabled()) return new NextResponse('Not Found', { status: 404 });
  const q = req.nextUrl.searchParams;
  try {
    const r = await completeConnect(caller, await sessionIdOf(req.headers), { code: q.get('code'), state: q.get('state'), error: q.get('error'), iss: q.get('iss') });
    return back(r.oldRevoked === false ? 'revokefail' : 'linked');
  } catch (e) {
    if (e instanceof ConnectError) return back(e.flag);
    console.error('mail connect failed:', e instanceof Error ? e.name : 'error');
    return back('error');
  }
}
