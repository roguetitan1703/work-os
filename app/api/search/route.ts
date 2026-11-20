import { NextResponse } from 'next/server';
import { callerFromHeaders, withCaller } from '@/lib/caller';
import { searchAll } from '@/lib/search';
import { isKind } from '@/lib/search/match';

// Global search (lib/search): GET /api/search?q=...&kind=tasks. The signed-in person only (the session cookie; proxy.ts
// guards /api and this checks again), and it searches only what they can see. A route, not a server action: an action
// sets the session cookie on its answer, and a cookie set by an action re-renders the page behind it (hundreds of KB on
// every keystroke). `kind` limits it to one kind (the filter), with more hits.

export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: Request) {
  const caller = await callerFromHeaders(req.headers, false);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const sp = new URL(req.url).searchParams;
  const kind = sp.get('kind');
  const res = await withCaller(caller, () => searchAll({ userId: caller.userId, orgId: caller.orgId }, sp.get('q') ?? '', isKind(kind) ? kind : undefined));
  return NextResponse.json(res, { headers: NO_STORE });
}
