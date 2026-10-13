import { NextResponse } from 'next/server';
import { get } from '@vercel/blob';

// Streams a private note attachment. Only reachable when logged in (proxy.ts), so files in
// notes are never public. Usage: /api/notes/file?p=notes/<name>

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get('p') ?? '';
  if (!p.startsWith('notes/') || p.includes('..')) return new NextResponse('bad path', { status: 400 });
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
