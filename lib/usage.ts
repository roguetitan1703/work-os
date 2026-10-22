// Request log (docs/usage-log.md). proxy.ts classifies every request it sees (requestKind, requestCaller, routePattern) and calls
// recordRequest() (event.waitUntil), so counting never blocks or slows a request; counts are written in small batches.
// Stored as hourly buckets in `requestStats`: { _id: 'YYYY-MM-DDTHH' (UTC), at, total, counts: { 'kind|caller|route': n } }.
// Nothing user-typed is stored: routes are fixed patterns, ids and query strings are dropped,
// callers are a fixed word (no keys, key ids or IPs).

export type UsageKind = 'page' | 'rsc' | 'action' | 'api';
export type UsageCaller = 'browser' | 'worker' | 'mcp' | 'cron' | 'discord' | 'anonymous';
export type UsageHit = { kind: UsageKind; caller: UsageCaller; route: string };

export const USAGE_KINDS: UsageKind[] = ['page', 'rsc', 'action', 'api'];
export const USAGE_CALLERS: UsageCaller[] = ['browser', 'worker', 'mcp', 'cron', 'discord', 'anonymous'];
export const USAGE_KEEP_DAYS = 35;

// Every route the app serves, as [regex, pattern]. A path that matches none is counted as (other) / /api/(other),
// so a typo or a scan never lands in the log verbatim. Add new routes here.
const S = '[^/]+';
const ROUTE_LIST: [string, string][] = [
  ['/', '/'],
  ['/today', '/today'],
  ['/tasks', '/tasks'],
  [`/tasks/${S}`, '/tasks/[id]'],
  ['/projects', '/projects'],
  [`/projects/${S}`, '/projects/[id]'],
  ['/notes', '/notes'],
  [`/notes/${S}`, '/notes/[id]'],
  [`/modes/${S}`, '/modes/[mode]'],
  ['/notifications', '/notifications'],
  ['/review', '/review'],
  ['/settings', '/settings'],
  ['/claude', '/claude'],
  ['/menu', '/menu'],
  ['/timetable', '/timetable'],
  ['/login', '/login'],
  ['/login/reset', '/login/reset'],
  [`/accept-invitation/${S}`, '/accept-invitation/[id]'],
  ['/api/auth/.+', '/api/auth/[all]'], // no dots: route names are Mongo field names
  ['/api/mcp', '/api/mcp'],
  [`/api/mcp/${S}`, '/api/mcp/[key]'],
  ['/api/worker/jobs', '/api/worker/jobs'],
  ['/api/worker/status', '/api/worker/status'],
  ['/api/worker/folders', '/api/worker/folders'],
  ['/api/cron/alerts', '/api/cron/alerts'],
  ['/api/discord/interactions', '/api/discord/interactions'],
  ['/api/admin/health', '/api/admin/health'],
  ['/api/admin/discord/register', '/api/admin/discord/register'],
  ['/api/notes/file', '/api/notes/file'],
  ['/api/notes/upload', '/api/notes/upload'],
  ['/api/timetable/today', '/api/timetable/today'],
];
const ROUTES = ROUTE_LIST.map(([re, p]) => [new RegExp(`^${re}/?$`), p] as const);

export function routePattern(pathname: string): string {
  for (const [re, p] of ROUTES) if (re.test(pathname)) return p;
  return pathname.startsWith('/api/') ? '/api/(other)' : '(other)';
}

/**
 * kind:
 * - api: any /api/ path
 * - action: a server action (POST with the Next-Action header)
 * - page: a full page load (the browser asks for a document / HTML)
 * - rsc: the client router fetching page data: a navigation, a refresh or a prefetch. Next.js strips the
 *   RSC and prefetch headers before the proxy sees the request, so these cannot be told apart here.
 */
export function requestKind(method: string, pathname: string, h: Headers): UsageKind {
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'api';
  if (method === 'POST' && h.has('next-action')) return 'action';
  // A page load is a navigation asking for HTML. The router's data fetches send neither (Accept */*). The service worker
  // re-fetches navigations (public/sw.js), so check the mode and Accept, not only Sec-Fetch-Dest.
  const dest = h.get('sec-fetch-dest');
  if (dest === 'document' || dest === 'iframe' || h.get('sec-fetch-mode') === 'navigate') return 'page';
  return (h.get('accept') ?? '').includes('text/html') ? 'page' : 'rsc';
}

/** Has this request any credential at all? Presence only; nothing is checked or stored. */
function hasKey(h: Headers): boolean {
  return /^Bearer\s+\S/i.test(h.get('authorization') ?? '') || !!h.get('x-api-key');
}

/**
 * caller. The self-authenticating endpoints are named after who they are for, when the request carries a credential
 * (it is not verified here; the route does that). Everything else: browser when the session cookie checked out
 * (`session`), mcp for a Work OS API key (`token`, checked by the proxy), else anonymous.
 */
export function requestCaller(pathname: string, h: Headers, url: URL, auth: { session: boolean; token: boolean }): UsageCaller {
  if (pathname.startsWith('/api/mcp')) return hasKey(h) || pathname.startsWith('/api/mcp/') ? 'mcp' : 'anonymous';
  if (pathname.startsWith('/api/worker')) return hasKey(h) ? 'worker' : 'anonymous';
  if (pathname.startsWith('/api/cron')) return hasKey(h) || url.searchParams.has('key') ? 'cron' : 'anonymous';
  if (pathname.startsWith('/api/discord/interactions')) return h.has('x-signature-ed25519') ? 'discord' : 'anonymous';
  if (auth.session) return 'browser';
  if (auth.token) return 'mcp';
  return 'anonymous';
}

export function hourKey(d: Date): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH, UTC
}

// Counts are gathered in memory and written in one batch shortly after the first request of a burst (FLUSH_MS):
// a page view fires a dozen prefetches at once, and one upsert each would compete with the page's own queries.
// Every request's waitUntil gets the promise of the write that carries its count, so a serverless instance stays
// up until it is saved. Failures are swallowed (the counts of that batch are lost).
const FLUSH_MS = 400;
const HOUR = 3_600_000;
let pending = new Map<string, Map<string, number>>(); // hour key -> 'kind|caller|route' -> n
let scheduled: Promise<void> | null = null;

async function flush(batch: Map<string, Map<string, number>>): Promise<void> {
  try {
    const { getDb } = await import('./db');
    const db = await getDb(); // scope-ok: request counters: operational, no work data
    await db.collection<{ _id: string }>('requestStats').bulkWrite( // scope-ok: request counters: operational, no work data
      [...batch].map(([hour, counts]) => {
        const inc: Record<string, number> = { total: [...counts.values()].reduce((a, n) => a + n, 0) };
        for (const [k, n] of counts) inc[`counts.${k.replace(/[.$]/g, '_')}`] = n; // a dot would split the field path and fail the batch
        return { updateOne: { filter: { _id: hour }, update: { $inc: inc, $setOnInsert: { at: new Date(`${hour}:00:00Z`) } }, upsert: true } };
      }),
      { ordered: false },
    );
  } catch {
    // counting must never affect a request
  }
}

/** Count one request. The returned promise settles when its count is written (or failed); it never rejects. */
export function recordRequest(hit: UsageHit, now = new Date()): Promise<void> {
  const hour = hourKey(new Date(Math.floor(now.getTime() / HOUR) * HOUR));
  const key = `${hit.kind}|${hit.caller}|${hit.route}`;
  const m = pending.get(hour) ?? new Map<string, number>();
  m.set(key, (m.get(key) ?? 0) + 1);
  pending.set(hour, m);
  scheduled ??= new Promise<void>(r => setTimeout(r, FLUSH_MS)).then(() => {
    const batch = pending;
    pending = new Map();
    scheduled = null;
    return flush(batch);
  });
  return scheduled;
}
