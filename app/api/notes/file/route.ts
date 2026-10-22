import { NextResponse } from 'next/server';
import { get } from '@vercel/blob';
import { callerFromRequest } from '@/lib/caller';
import { firstOrgId } from '@/lib/people';

// Streams a private note attachment. Only for a signed-in caller (proxy.ts, and checked again here), so files in
// notes are never public, and only from the caller's organization. Usage: /api/notes/file?p=notes/<orgId>/<name>.
// Files from before organizations (notes/<name>) belong to the first organization.

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = new URL(req.url).searchParams.get('p') ?? '';
  if (!p.startsWith('notes/') || p.includes('..')) return new NextResponse('bad path', { status: 400 });
  const parts = p.split('/');
  const mine = parts.length === 3 ? parts[1] === caller.orgId : parts.length === 2 && caller.orgId === (await firstOrgId());
  if (!mine) return new NextResponse('not found', { status: 404 });
  const r = await get(p, { access: 'private' }).catch(() => null);
  if (!r || r.statusCode !== 200) return new NextResponse('not found', { status: 404 });
  const name = p.split('/').pop() ?? 'file';
  return new NextResponse(r.stream, {
    headers: {
      'Content-Type': r.blob.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
