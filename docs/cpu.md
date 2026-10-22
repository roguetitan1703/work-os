# Server CPU (phase 0 of docs/multi-user.md)

Vercel paused the account for too much serverless CPU. This is what was cut before Work OS runs anywhere else, and how to measure it again.

## Measured: before and after

Counted with the mongod profiler on a throwaway database holding 400 tasks (150 open, with descriptions), 150 notes of about 20 KB and 2 projects (`tests/e2e/cpu-probe.mjs`). "ops" are database operations the request caused, including the one `requestStats` upsert every request makes (`lib/usage.ts`) and the sign-in check. "docs/KB" is what came back from the database. Before = master at eaaffe2.

| Request | ops before | ops after | docs / KB before | docs / KB after |
|---|---|---|---|---|
| /today (page + layout) | 18 | 17 | 361 / 2227 | 160 / 83 |
| /tasks | 11 | 10 | 508 / 4274 | 307 / 161 |
| /projects | 10 | 9 | 307 / 27 | 10 / 3 |
| /notes | 13 | 12 | 409 / 1791 | 208 / 83 |
| /claude | 21 | 20 | 209 / 17 | 8 / 5 |
| Layout alone (every page) | 6 | 5 | whole project docs + every open and recent task | project id/name/status + 3 counts |
| Worker poll, idle, dispatcher off | 10 | 7 | 2 / 2 | 1 / 1 |
| Worker poll, idle, dispatcher on, nothing queued | 15 | 8 | 4 / 3 | 2 / 2 |
| MCP call (list_projects) | 6 | 5 | 154 / 2066 | 58 / 222 |
| MCP call (list_tasks) | 5 | 4 | 103 / 77 | 103 / 77 |

Operation counts barely move for pages: the cost was documents and bytes (every open task with its full text, every note with its blocks), which is CPU for the server and the database driver on every render. The layout numbers are from reading the code (the probe measures whole pages); `getStats` used to read every open task and every task done since last week just for the overdue badge.

Besides database work, each MCP call used to build the whole MCP server (about 60 tools with their schemas); idle servers are now reused.

## What changed

- **Projections and counts.** The layout takes the overdue badge from one indexed count (`overdueCount`) and the project list with only id, name and status (`listProjectsNav`). `getStats`, `listProjects` and the per-project counts are computed in the database (`$group`), not by loading tasks. `computeAlerts` projects the task fields it uses. Notes: `listNotes` (and `noteIndex`) read a 500-character prefix and the full length instead of the whole body, `noteIndex` reads only the first 8 blocks (enough for the first-line preview), parents and projects are read with a few fields, and Today and Tasks ask only "which of these tasks have a note" (`taskIdsWithNotes`, ids only). Every page shows the same thing as before.
- **Prefetch.** `dynamicOnHover` is off (hovering a link no longer renders a page). The preloader warms only Today, Tasks and Projects. Links that forced a full prefetch (tab bar, Claude tabs, project tabs, Settings sections) use the default: the page down to `app/(app)/loading.tsx` is prefetched, the rest is fetched on tap. Cost: Menu, Settings, Claude and the tabs inside them wait for one server round trip on first tap.
- **Indexes.** `lib/db.ts` keeps the index list as data, hashes it, and creates indexes only when the hash stored in `settings` (`_id: 'indexes'`) differs. Once per process, one read on a cold start; editing the list changes the hash by itself.
- **MCP.** `lib/mcp/pool.ts` keeps up to 3 idle servers per caller identity and base URL (10 minutes) and reconnects them to a fresh transport; concurrent calls get their own server. `markSeen` writes at most once a minute per kind per process.
- **Worker poll.** The per-poll rate limit is counted in memory (no `policyEvents` insert and count). Linked folders and their project names come from one query; the jobs query returns every unfinished job once and also answers "busy"; the "session starting" count only runs when that is still unknown. With the dispatcher on and nothing queued or running, one indexed read replaces settling and claiming, and the alert flush runs only when the dispatcher was active.

## Not done

- /today still reads every open task with its full document (the page sends them to the browser). Cutting it needs a smaller task shape for the client.
- `/today` and `/claude` still run `claudeOverview` (about 12 reads of sessions, devices and folders). Phase 5 (push instead of polling) replaces the polling behind it.
- Dispatcher settings are read on every poll (tests and the UI write them directly, so no cache). Device key check is one read per poll; caching it would delay revocation.
- Session check, sign-in and `lib/usage.ts` belong to phase 1 and were not touched.

## Measuring again

`E2E_EXTRA='cpu|cpu-probe.mjs|base|plain' SKIP_BUILD=1 bash tests/e2e/run.sh cpu` (after a build) prints a `COUNT` line per request type in the suite log (`E2E_LOGS=<dir>` keeps it).
