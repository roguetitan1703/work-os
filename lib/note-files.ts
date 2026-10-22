// Note attachments (images and files in the block editor), stored in the private Blob store under
//   notes/<orgId>/<noteId>/<file name>
// A file belongs to the note it was uploaded into and is served only to people who can see that note
// (app/api/notes/file). Plain rules with no imports, so the e2e suites can check them directly.

/** Shown in the page (inline). No SVG: it can carry script. */
export const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** What the upload route accepts. Anything not inline is served as a download. */
export const UPLOAD_TYPES = [
  ...INLINE_TYPES,
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,120}$/;

/** notes/<orgId>/<noteId>/<name>, or null for anything else (older shapes included). */
export function parseNoteFilePath(p: unknown): { orgId: string; noteId: string; name: string } | null {
  if (typeof p !== 'string' || p.includes('..')) return null;
  const parts = p.split('/');
  if (parts.length !== 4 || parts[0] !== 'notes') return null;
  const [, orgId, noteId, name] = parts;
  if (!ID.test(orgId) || !ID.test(noteId) || !NAME.test(name) || name.startsWith('.')) return null;
  return { orgId, noteId, name };
}

const baseType = (t: string | null | undefined) => (t ?? '').split(';')[0].trim().toLowerCase();

/**
 * Response headers for a stored file. Only the image types above are shown inline; everything else is a download
 * with a type that cannot render as a page. The sandbox policy and nosniff stop a stored file from running script
 * on this origin even if a browser were to render it.
 */
export function noteFileHeaders(contentType: string | null | undefined, name: string): Record<string, string> {
  const t = baseType(contentType);
  const inline = (INLINE_TYPES as readonly string[]).includes(t);
  const known = (UPLOAD_TYPES as readonly string[]).includes(t) && !t.startsWith('text/');
  const file = name.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-120) || 'file';
  return {
    'Content-Type': inline || known ? t : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  };
}
