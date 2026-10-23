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

- /today and /tasks still send every open task to the browser. The list shape drops description, links and source
  (Multi-user, below), but each task is still about 1.9 KB uncompressed.
- `/today` and `/claude` still run `claudeOverview` (about 12 reads of sessions, devices and folders). Since push
  (below), `/claude` runs it only when something it shows changed, not every 30 s. Today's card reads only the
  items waiting on you.
- Dispatcher settings are read on every poll (tests and the UI write them directly, so no cache). Device key check is one read per poll; caching it would delay revocation. With push a worker polls every 5 minutes instead of every 30 s.
- Session check, sign-in and `lib/usage.ts` belong to phase 1 and were not touched.

## Push (phase 5): requests per hour, before and after

Measured 2026-10-22 on the same build: before = the push stream blocked, so the page and worker fall back to the
polling they did until now.

| Idle client, one hour | Before (polling) | After (push) |
|---|---|---|
| Claude page, open and in use (input every 30 s) | 724 to 939 page fetches (two runs) | 36 page fetches (all from the preloader, not the Claude page) + 2 stream connects |
| Claude page, open and untouched | 70 to 72 page fetches | 6 page fetches (preloader, first 10 minutes) + 2 stream connects |
| Worker, PC on, no session started from Work OS | 150 (120 job polls, 30 status) | 16 (12 job polls, 2 status, 2 stream connects) |

How:
- **Claude page.** `tests/e2e/push.mjs`, last section. Playwright runs a simulated hour (`page.clock`) on `/claude`
  and counts the page's requests, once with `/api/stream` blocked and once with it open. "Page fetches" are RSC requests.
  Before, each 30-second refresh also fetched again every link that was prefetched (about 6 requests per refresh;
  see WORK-STATE Later on revalidation).
- **Stream connects.** One stream connects when the page opens, then once per 30 minutes (`STREAM_TTL_MS`), so 2 an
  hour. This is not visible inside the simulated hour, because the server's timer runs in real time.
- **Worker.** `worker/test/loop.test.mjs` runs the real loop and core against a counting fake API on a simulated
  clock, with push down and with push up.

A change still costs one page fetch for each open Claude page that can see it, and the job a worker is woken for
costs one poll. The time from Stop on the page to the job reaching the worker was about 0.3 to 0.4 s in the suite.

The preloader still warms Today, Tasks and Projects every 5 minutes while a tab is in use (36 an hour). It now makes
up all of an in-use Claude page's requests. It could warm only after a hint instead (WORK-STATE Later).

Server side, a write costs nothing extra while nobody in its organization has a page open. When someone else does,
it costs one small read (docs/multi-user.md "As built: phase 5 push"). Worker heartbeats now write a computer's
report in one operation instead of three.

## Multi-user: a team of 20 on a t3.small

Measured 2026-10-23 with the load simulation (tests/load/README.md). It seeds one organization: 20 people, 50
projects, 2,000 tasks (688 open), 300 notes and 150 Claude items. It then runs an 8-hour working day compressed into
20 minutes against `next start` with the heap capped at 1024 MB, as on the box.

The load:
- 2 real Chromium tabs and 18 scripted browsers that send what a real tab sends. The tabs were not all real because
  the dev PC is short of RAM.
- 20 workers on push streams; 3 people use the dispatcher.
- Every person's Claude calls MCP.
- About 15 things an hour per person (open, edit, complete, look around), an hour for lunch, and a third of people
  keeping the Claude page open.

Before = master at aeab2b4. After = this branch.

The before server was saturated (event-loop p99 211 ms), so it got through 21% fewer things in the same time. The
"per thing" rows compare like with like; the per-user-hour figures are the simulation's own.

| Whole day, server process | Before | After |
|---|---|---|
| Things done / writes / MCP calls | 1,374 / 393 / 890 | 1,749 / 517 / 958 |
| CPU seconds (dev PC) | 1,144 | 428 |
| CPU per thing done | 0.83 s | 0.24 s (3.4x less) |
| Requests (all kinds) | 94,031 | 13,848 |
| Requests per thing done | 68 | 7.9 |
| Per user-hour: CPU / requests / KB sent | 7.1 s / 588 / 1,329 | 2.6 s / 87 / 896 |
| Per user-hour: DB operations / documents examined | 752 / 59,275 | 534 / 48,061 |
| Collection scans (no index) in the day | about 30,000 | 0 |
| Memory: RSS peak / heap peak | 449 / 243 MB | 356 / 216 MB |
| Event loop p99 / max | 211 / 1,794 ms | 30 / 258 ms |
| Everyone away, 20 tabs and 20 workers connected | 15 CPU s an hour | 19 CPU s an hour |

One real tab through a short session (`tests/load/patterns.mjs`), requests per step:

| Step | Before | After |
|---|---|---|
| Load /today | 51 | 5 |
| Nav Tasks | 60 | 0 (the preloader already has it) |
| Complete a task | 48 | 1 |
| Claude page open, a teammate edits any task | 13 | 0 |
| A whole 8-hour day with the Claude page open (the simulation's real tab) | about 5,700 | 24 |

### What was fixed, by measured cost

1. **Prefetching links in view.**
   - What it cost: every link to a page that is not built ahead made two prefetch requests. Today and the Claude page
     have 20 to 30 such links. Every action revalidates, which drops the router's prefetch cache, so every write
     re-sent all of them. These requests were about 80% of all requests and most of the CPU.
   - The fix: links prefetch on hover, focus or touch (`components/intent-link.tsx`, imported in place of
     `next/link`). The preloader still warms Today, Tasks and Projects.
   - What it costs now: a link's first tap waits for one round trip when nothing hovered it first (phones).
2. **Claude-page refresh fan-out.** An open Claude page listened to `tasks` hints, so any teammate's task edit
   refreshed every open Claude page. It now listens to `claude` only. A task write that touches the `claude` mark (a
   task given to Claude) also sends `claude` (`lib/scope.ts`). Hints received by Claude pages fell from 1,696 to 38
   in the day.
3. **Missing indexes.** The sign-in session check (`session.token`), API keys, members, devices and projects by
   organization, and tasks' `dependsOn` (every task page and MCP `get_task` read 2,300 documents; now 305).
4. **Smaller list payloads.** Today and Tasks read tasks without description, links and source (`forList`). Today's
   Claude card reads only the items waiting on you (`claudeOverview(…, { card: true })`). /today data is 383 KB
   (21 KB gzipped) instead of 456 KB.
5. **No `router.refresh()` after actions that already revalidate** (the action's response carries the new page):
   Today's Claude card, Give to Claude, task row undo, mobile task actions and detail, comments, and the project's
   Claude card.

`pushed()` itself was not a cost: a write with 20 viewers costs one small read and 20 in-memory writes.

### t3.small projection

A t3.small earns 24 CPU credits an hour, which is 0.4 vCPU or 1,440 CPU seconds an hour. It can bank up to 576
credits and burst to 2 vCPUs. Assuming a t3 vCPU is 1.5x slower than the dev PC:

| | Before | After |
|---|---|---|
| Busy hour, 20 people | about 300 CPU s (0.08 vCPU) | 107 CPU s (0.03 vCPU) |
| A working day (8 busy hours, then idle) | about 2,860 CPU s, 8% of the daily baseline | 1,305 CPU s, 4% of the daily baseline |
| People who fit within the baseline | about 300 | about 1,000 |

20 people fit with a wide margin; CPU will not be the limit. The real ceiling is lower than the last row:
- one Node process uses one core;
- the busy hours come together;
- the database is Atlas, whose own tier has its own limits.

As a rough guide, about 250 people active at the same time would use the whole 0.4 vCPU baseline, before banked
credits. Memory: 356 MB RSS at peak, against 2 GB on the box (a 1,024 MB heap cap, nginx and the OS), so there is room.

### Graviton (t4g.small), shared with other apps

The server Work OS goes on is a **t4g.small**: 2 Graviton2 (arm64) vCPUs, 2 GiB, already running other apps
(docs/hosting.md section 1). Its credits are the same as a t3.small's: 24 an hour, a 20% baseline per vCPU (0.4 vCPU,
1,440 CPU seconds an hour), up to 576 banked, standard mode.

- **Speed.** Not measured on Graviton. A t4g vCPU is a whole core (a t3 vCPU is a hyperthread); for one Node process
  it is about as fast as a t3 vCPU, so the table above stands as it is: Work OS's working day is about 1,305 CPU s,
  4% of the daily baseline, and a busy hour 107 CPU s (0.03 vCPU). Check it on the box with
  `systemctl status work-os` (CPU time so far) after a working day.
- **Shared.** The 4% is Work OS's alone. The other apps spend from the same balance, and with standard credits the
  whole box is held to 20% per vCPU once the balance is empty, Work OS included. So what matters is the box's
  `CPUCreditBalance` in CloudWatch, not Work OS's share of it. Before the move, look at that graph for the last two
  weeks: if it already falls through the working day and only refills overnight, the other apps use most of the
  baseline and Work OS's 4% is what tips it.
- **Builds are not on the box** (docs/hosting.md section 7): a build used about 2 vCPU for several minutes, a good part
  of an hour's credits, and more memory than the box can spare. `npm ci --omit=dev` on a deploy is short.
- **Memory** is the tighter limit here: the box has 1.8 GiB for every app and already uses its swap. Work OS peaked
  at 216 MB of heap and 356 MB RSS with 20 people (measured above with a 1024 MB heap cap); on the box its unit caps
  the heap at 288 MB, slows it past 380 MB (`MemoryHigh`) and restarts it past 480 MB (`MemoryMax`)
  (docs/hosting.md section 6). Those caps are estimates, not measured on the box: the first weeks tell.

**When to size up.** Move to a t4g.medium (4 GiB; or set the instance to unlimited credits) when either of these happens:
- the CPU credit balance (CloudWatch `CPUCreditBalance`) goes down from one working week to the next instead of
  refilling overnight;
- the app's memory keeps reaching `MemoryHigh` (380 MB) or it is restarted at `MemoryMax` (`systemctl status
  work-os`, `journalctl -u work-os`), or the box's swap use keeps growing.

Look first at what changed: a new page or link pattern that costs much more shows up in the budgets suite before it
shows up on the box.

**What to watch.**
- Settings › Usage: requests per user-hour should stay near 90 for browsers. Page data ("rsc") is the largest kind;
  a jump in it usually means links prefetching again or a refresh loop. Each worker makes about 14 an hour.
- /api/admin/health `push`: the open streams. About one per open tab plus one per worker. 10 per person and 2 per
  computer are the caps.
- `journalctl -u work-os`: event-loop stalls show as slow requests. The service's memory shows in `systemctl status
  work-os`.

### Budgets

`tests/load/budgets.json` keeps every one of these numbers about 25% above what was measured:
- per request kind: KB, database operations, documents examined, and 0 collection scans;
- requests per step of the real session;
- requests in an idle hour: Claude page untouched 8, Claude page in use 45, Today page in use 32, worker 18;
- per user-hour for a minute of the whole team.

The `budgets` suite in `tests/e2e/run.sh` checks them in about 4 minutes and fails with
`budget <where> <metric>: <actual> <= <budget>`.

## Measuring again

`E2E_EXTRA='cpu|cpu-probe.mjs|base|plain' SKIP_BUILD=1 bash tests/e2e/run.sh cpu` (after a build) prints a `COUNT` line per request type in the suite log (`E2E_LOGS=<dir>` keeps it).

The team of 20: `LOAD_OUT=<dir> bash tests/load/run.sh` (about 25 minutes with the build; report.txt has every
number above). Replay the old behaviour with `LOAD_PREFETCH=viewport LOAD_CLAUDE_TOPICS=claude,tasks`, but that
replays only the client; the server fixes stay in.
