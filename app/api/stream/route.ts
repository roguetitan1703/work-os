import { NextResponse } from 'next/server';
import { callerFromHeaders } from '@/lib/caller';
import { liveResponse } from '@/lib/live-stream';

// Push stream for open pages (docs/multi-user.md "As built: phase 5 push"). The session cookie says who; the caller
// must still be a member of the session's organization (callerFromHeaders checks the membership). The stream carries
// only "refresh <topic>" hints for that person; the page then fetches itself through the normal, checked path.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const c = await callerFromHeaders(req.headers);
  if (!c) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return liveResponse(req, { kind: 'page', orgId: c.orgId, userId: c.userId });
}
