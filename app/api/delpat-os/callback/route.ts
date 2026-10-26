import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/lib/auth';
import { getCaller } from '@/lib/caller';
import { DelpatOsError, completeLink, delpatOsEnabled } from '@/lib/delpat-os';

// Where Delpat OS sends the browser back after the person allowed (or refused) Work OS (lib/delpat-os.ts completeLink).
// The person must be signed in here, as the same person and organization that started the link; the state proves it.
// Always answers with a redirect to Settings carrying one fixed word (linked or error); never the code, a token or text.

export const dynamic = 'force-dynamic';

const back = (flag: 'linked' | 'error') => {
  const u = new URL(`${appBaseUrl() ?? ''}/settings`);
  u.searchParams.set('section', 'connections');
  u.searchParams.set('delpat', flag);
  return NextResponse.redirect(u, { status: 303, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
};

export async function GET(req: NextRequest) {
  if (!delpatOsEnabled()) return new NextResponse('Not Found', { status: 404 });
  const caller = await getCaller();
  if (!caller) return back('error');
  const q = req.nextUrl.searchParams;
  try {
    await completeLink(caller, { code: q.get('code'), state: q.get('state'), error: q.get('error') });
    return back('linked');
  } catch (e) {
    if (!(e instanceof DelpatOsError)) console.error('delpat os link failed:', e instanceof Error ? e.name : 'error');
    return back('error');
  }
}
