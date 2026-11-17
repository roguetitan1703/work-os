import { MAX_NOTICE_BODY, NoticeSchema, bearerOf, intakeConfig, noticesConfigured, postNotice, readCapped, reportProblem, tokenMatches } from '@/lib/intake';

// Mailloom's short notices (its nightly updater) to one Discord channel, server to server:
// POST /api/intake/mailloom/notice (lib/intake.ts, docs/HANDOVER.md "Intake"). Authorization: Bearer
// <MAILLOOM_INTAKE_TOKEN>, JSON {text} (1-1900 characters, body at most 4 KB). The channel is MAILLOOM_NOTICE_CHANNEL
// only; the Work OS bot posts it with no mentions. proxy.ts lets /api/intake through: this route checks its own token.
//   204 posted · 400 bad input · 401 bad or missing token · 413 body over 4 KB · 429 over 20 an hour (Retry-After)
//   502 {error} Discord refused · 503 not configured (token, bot or channel)
// The log gets the status only: never the token or the text.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status: number, body: object | null, extra: Record<string, string> = {}) => {
  console.log(`[intake] mailloom notice ${status}`);
  return body ? Response.json(body, { status, headers: { ...HEADERS, ...extra } }) : new Response(null, { status, headers: { ...HEADERS, ...extra } });
};

export async function POST(req: Request): Promise<Response> {
  const cfg = intakeConfig();
  if (!cfg || !noticesConfigured()) return reply(503, { error: 'Mailloom notices are not configured on this server.' });
  if (!tokenMatches(bearerOf(req), cfg.token)) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  const text = await readCapped(req, MAX_NOTICE_BODY);
  if (text === null) return reply(413, { error: `The notice is larger than ${MAX_NOTICE_BODY / 1024} KB.` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400, { error: 'The body is not JSON.' });
  }
  const parsed = NoticeSchema.safeParse(raw);
  if (!parsed.success) return reply(400, { error: reportProblem(parsed.error) });
  try {
    const r = await postNotice(parsed.data.text);
    if (r.status === 204) return reply(204, null);
    if (r.status === 429) return reply(429, { error: 'Too many notices in the last hour; try again later.' }, { 'Retry-After': String(r.retryAfter) });
    return reply(r.status, { error: r.error });
  } catch (e) {
    console.error('[intake] notice failed:', e instanceof Error ? e.name : 'error');
    return reply(500, { error: 'Something went wrong; try again.' });
  }
}

const notAllowed = () => new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST', 'Content-Type': 'application/json' } });
export const GET = notAllowed;
export const HEAD = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
