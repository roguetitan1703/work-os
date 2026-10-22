# Request log (Settings › Usage)

Vercel Hobby has a monthly limit on edge requests but shows no per-route breakdown. Work OS keeps its own count of
the requests that reach the app, so you can see where they come from. Open it at **Settings › Usage**
(`/settings?section=usage`).

## What is counted

Every request that reaches `proxy.ts`:

- page loads (address bar, reload, a tapped notification)
- page data fetched by the client router (tapping a link, `router.refresh()`, prefetches, the preloader)
- server actions (buttons and forms that save)
- every `/api/` route, including `/api/mcp`, `/api/worker/*`, `/api/cron/*` and `/api/discord/interactions`
- redirects to `/login` and refused requests (they still cost a request)

## What is not counted

- Static files: `/_next/static`, `/_next/image`, `/icons/*`, `manifest.webmanifest`, `sw.js`, `offline.html`,
  `robots.txt`, `.well-known`, `favicon.ico`. The CDN serves them and they never reach the proxy. Vercel's limit
  counts them too, so its number is always higher than ours.
- Redirects in `next.config.ts` (`/connect`, `/history`, `/board`, …): Next.js answers them before the proxy runs.

## How each request is classified

Each request adds 1 to a key `kind|caller|route` in the bucket for its UTC hour.

**kind** (`requestKind` in `lib/usage.ts`)
- `api`: the path starts with `/api/`
- `action`: a POST with the `Next-Action` header
- `page`: a navigation asking for HTML (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, or `Accept: text/html`)
- `rsc` ("Page data" in the UI): everything else on a page path, i.e. the client router's data fetches.
  Navigations, refreshes and prefetches cannot be told apart: Next.js 16 strips the `RSC` and `Next-Router-Prefetch`
  headers (and the `_rsc` query) before the proxy sees the request, and a full prefetch (hover, the preloader) sends
  the same request as a navigation anyway. `skipProxyUrlNormalize` would expose the headers but changes the URL the
  proxy sees for every request, including the auth check, so it is not used.

**caller** (`requestCaller`)
- `/api/mcp*`: `mcp` when a key header is present (or the key is in the URL), else `anonymous`
- `/api/worker*`: `worker` when a key header is present, else `anonymous`
- `/api/cron*`: `cron` when a key header is present, else `anonymous`
- `/api/discord/interactions`: `discord` when the Discord signature header is present, else `anonymous`
- anything else: `browser` when the session cookie checked out (on `/login` and `/login/reset`: when one is present),
  `mcp` when `MCP_TOKEN` opened an API route, else `anonymous`

On the self-authenticating routes the caller only says a credential was sent, not that it was valid; the route checks it.

**route** (`routePattern`): a fixed pattern from the table in `lib/usage.ts` (`/tasks/[id]`, `/projects/[id]`,
`/notes/[id]`, `/modes/[mode]`, `/api/mcp/[key]`, …). Anything not in the table becomes `(other)` or `/api/(other)`.
**Add new routes to that table**, or they show up as `(other)`.

Nothing user-typed or secret is stored: no ids, query strings, keys, key ids, cookies or IP addresses.

## Storage

Collection `requestStats` (registered in `lib/db.ts`):

```
{ _id: '2026-10-18T08',            // UTC hour
  at: ISODate('2026-10-18T08:00Z'), // TTL index: removed after 35 days
  total: 412,
  counts: { 'rsc|browser|/today': 120, 'api|worker|/api/worker/jobs': 240, … } }
```

Counts are gathered in memory and written in one `bulkWrite` (`$inc`, `upsert`) about 400 ms after the first request
of a burst, so a page view with a dozen prefetches costs one write, not twelve. The proxy hands that write to
`event.waitUntil`, so it runs after the response and never delays or changes a request; errors are swallowed (that
batch's counts are lost). Set `USAGE_LOG=off` in the environment to stop counting altogether.

Reading: `lib/data/usage.ts` (`usageReport`); UI: `app/(app)/settings/usage-section.tsx`. Per-day totals use India
time; each UTC hour goes to the day it starts in, so the day edges are off by half an hour.

## The proxy change

Before the request log, `proxy.ts`'s matcher skipped `/api/mcp`, `/api/worker`, `/api/cron` and
`/api/discord/interactions` entirely. Now the matcher includes them so they are counted, and `guard()` lets them
through first, with the same prefix test the matcher used, so their auth is unchanged: each still checks its own
credentials and never sees the session check or `MCP_TOKEN` fallback. The `usage` e2e suite proves it (a `wkr_` key
opens the worker API, `CRON_SECRET` opens cron and a `wos_` key opens MCP, none of which the proxy would accept; and
`MCP_TOKEN` is still refused by the worker and cron routes).

Side effects of matching them:
- the proxy now runs on those calls (one extra proxy invocation each, a few ms of CPU; no extra edge request);
- Next.js buffers request bodies for the proxy up to 10 MB (`proxyClientMaxBodySize`); these routes take small JSON
  bodies (the worker routes refuse anything over 1 MB).
