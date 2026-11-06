import { buildIcs } from '@/lib/calendar-ics';
import { feedOwner, recordMiss, tooManyMisses } from '@/lib/calendar-feed';
import { feedTasks } from '@/lib/data/calendar';
import { timezoneOf } from '@/lib/profile';

// The calendar feed (docs/calendar.md): GET /api/calendar/<token>.ics. The token is the only credential: no session, no
// cookies. proxy.ts lets it through untouched. Anything wrong with it (malformed, unknown, rotated, turned off, the
// person left) answers the same bare 404.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };
const text = (body: string, status: number) => new Response(body, { status, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  if (tooManyMisses(req.headers)) return text('Too many requests', 429);
  const { file } = await ctx.params;
  const owner = file.endsWith('.ics') ? await feedOwner(file.slice(0, -4)).catch(() => null) : null;
  if (!owner) {
    recordMiss(req.headers);
    return text('Not found', 404);
  }
  try {
    const [tasks, tz] = await Promise.all([feedTasks(owner), timezoneOf(owner)]);
    const baseUrl = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
    return new Response(buildIcs(tasks, { baseUrl, tz, now: new Date() }), {
      headers: { ...HEADERS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="work-os.ics"' },
    });
  } catch (e) {
    console.error('[calendar]', e);
    return text('Error', 500);
  }
}
