import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { callerFromRequest, type Caller } from '@/lib/caller';
import { parseNoteFilePath, UPLOAD_TYPES } from '@/lib/note-files';
import { scoped } from '@/lib/scope';

// Issues short-lived tokens so the browser uploads note images/files straight to Vercel Blob
// (private store; no 4.5 MB function body limit). Behind the app's sign-in (proxy.ts, and checked again here).
// A file goes under the note it is added to (notes/<orgId>/<noteId>/<name>), which the caller must be able to see;
// the file route then serves it only to people who can see that note. Types: lib/note-files.ts.

export const runtime = 'nodejs';

const MAX_BYTES = 50 * 1024 * 1024;

/** The path is a file of a live note this caller can see, in their organization. */
async function ownPath(caller: Caller, p: unknown): Promise<boolean> {
  const f = parseNoteFilePath(p);
  if (!f || f.orgId !== caller.orgId) return false;
  const c = await scoped({ userId: caller.userId, orgId: caller.orgId });
  return !!(await c.notes.findOne({ _id: f.noteId, deletedAt: null }, { projection: { _id: 1 } }));
}

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  if (body.type === 'blob.generate-client-token' && !(await ownPath(caller, body.payload?.pathname))) return NextResponse.json({ error: 'Invalid upload path' }, { status: 400 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'File uploads are not set up: connect a Vercel Blob store to this project.' }, { status: 503 });
  }
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!(await ownPath(caller, pathname))) throw new Error('Invalid upload path');
        return { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true, allowedContentTypes: [...UPLOAD_TYPES] };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload failed' }, { status: 400 });
  }
}
