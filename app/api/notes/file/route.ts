import { NextResponse } from 'next/server';
import { get } from '@vercel/blob';
import { callerFromRequest } from '@/lib/caller';
import { noteFileHeaders, parseNoteFilePath } from '@/lib/note-files';
import { scoped } from '@/lib/scope';

// Streams a private note attachment: /api/notes/file?p=notes/<orgId>/<noteId>/<name>. Only for a signed-in caller
// (proxy.ts, and checked again here) who can see the note the file was uploaded into (a private note's files are its
// owner's only). Images show inline; everything else downloads (lib/note-files.ts). Older path shapes are not served:
// uploads were switched off until this layout (block-editor.tsx UPLOADS_ENABLED).

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = new URL(req.url).searchParams.get('p') ?? '';
  if (!raw.startsWith('notes/') || raw.includes('..')) return new NextResponse('bad path', { status: 400 });
  const f = parseNoteFilePath(raw);
  if (!f || f.orgId !== caller.orgId) return new NextResponse('not found', { status: 404 });
  const note = await (await scoped({ userId: caller.userId, orgId: caller.orgId })).notes.findOne({ _id: f.noteId }, { projection: { _id: 1 } });
  if (!note) return new NextResponse('not found', { status: 404 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return new NextResponse('file storage is not set up', { status: 503 });
  const r = await get(raw, { access: 'private' }).catch(() => null);
  if (!r || r.statusCode !== 200) return new NextResponse('not found', { status: 404 });
  return new NextResponse(r.stream, { headers: noteFileHeaders(r.blob.contentType, f.name) });
}
