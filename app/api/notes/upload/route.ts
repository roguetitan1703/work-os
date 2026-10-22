import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { callerFromRequest } from '@/lib/caller';

// Issues short-lived tokens so the browser uploads note images/files straight to Vercel Blob
// (private store; no 4.5 MB function body limit). Behind the app's sign-in (proxy.ts, and checked again here).

export const runtime = 'nodejs';

const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Each organization's files under its own folder; the file route serves only the caller's.
  const ownPath = (p: unknown) => typeof p === 'string' && p.startsWith(`notes/${caller.orgId}/`) && !p.includes('..');
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  if (body.type === 'blob.generate-client-token' && !ownPath(body.payload?.pathname)) return NextResponse.json({ error: 'Invalid upload path' }, { status: 400 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'File uploads are not set up: connect a Vercel Blob store to this project.' }, { status: 503 });
  }
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!ownPath(pathname)) throw new Error('Invalid upload path');
        return { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload failed' }, { status: 400 });
  }
}
