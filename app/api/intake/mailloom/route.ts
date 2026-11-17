import { after } from 'next/server';
import { flushQueuedAlerts } from '@/lib/alerts';
import { MAX_BODY, ReportSchema, bearerOf, intakeConfig, readCapped, reportProblem, takeReport, tokenMatches } from '@/lib/intake';

// Mailloom's "Report a problem" form, server to server: POST /api/intake/mailloom (lib/intake.ts, docs/HANDOVER.md
// "Intake"). Authorization: Bearer <MAILLOOM_INTAKE_TOKEN>; the token can only make a report task in the one project
// MAILLOOM_INTAKE_PROJECT names. proxy.ts lets /api/intake through untouched: this route checks its own credential.
//   201 {ref, url} new task · 200 {ref, url} report_id seen before · 400 {error} bad input · 401 bad or missing token
//   413 body over 64 KB · 429 over 60 new reports an hour (Retry-After) · 503 not configured, or the project is gone
// The log gets the status and the task number only: never the token, the body or the reporter's text.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status: number, body: object, extra: Record<string, string> = {}) => {
  console.log(`[intake] mailloom ${status}${'ref' in body ? ` #${(body as { ref: number }).ref}` : ''}`);
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
};

const appUrl = (req: Request) => (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');

export async function POST(req: Request): Promise<Response> {
  const cfg = intakeConfig();
  if (!cfg) return reply(503, { error: 'The Mailloom intake is not configured on this server.' });
  if (!tokenMatches(bearerOf(req), cfg.token)) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return reply(413, { error: `The report is larger than ${MAX_BODY / 1024} KB.` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400, { error: 'The body is not JSON.' });
  }
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) return reply(400, { error: reportProblem(parsed.error) });
  try {
    const r = await takeReport(cfg, parsed.data);
    if (r.status === 503) return reply(503, { error: r.error });
    if (r.status === 429) return reply(429, { error: 'Too many reports in the last hour; try again later.' }, { 'Retry-After': String(r.retryAfter) });
    const base = appUrl(req);
    if (r.status === 201 && r.scope) {
      const s = r.scope;
      after(() => flushQueuedAlerts(s, base)); // the owner's "assigned to you" notice
    }
    return reply(r.status, { ref: r.ref, url: `${base}/tasks/${r.ref}` });
  } catch (e) {
    console.error('[intake] failed:', e instanceof Error ? e.name : 'error'); // the name only: a message could carry report text
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
