# End-to-end suites

Browser (Playwright) and API suites that run against a production build of the app and a throwaway MongoDB. They never touch the real database: `run.sh` starts its own `mongod` on port 27281 and the app on port 3281, moves `.env.local` aside while it runs, and puts everything back when it stops (also on Ctrl+C or a failure).

## Run

```
bash tests/e2e/run.sh                 # everything (about 10 to 15 minutes, most of it the build and the two idle-wait suites)
bash tests/e2e/run.sh today search    # only these suites
SKIP_BUILD=1 bash tests/e2e/run.sh nav  # reuse the last .next build
```

It prints a table of suites with pass and fail counts and exits non-zero if any suite failed.

Needs: Windows with MongoDB 8.2 at `C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe`, Node 22, and a `playwright-core` with a Chromium. Overrides (all optional):

| Variable | Meaning | Default |
| --- | --- | --- |
| `MONGOD` | path of the mongod binary | the 8.2 path above |
| `PLAYWRIGHT_CORE` | folder of `playwright-core` | `playwright-core` from the repo if installed, else `C:/Users/VICTUS/AppData/Roaming/npm/node_modules/@delpat/tutorial-videos/node_modules/playwright-core` |
| `CHROME_EXE` | Chromium executable | `%LOCALAPPDATA%/ms-playwright/chromium-1243/chrome-win64/chrome.exe`, else Playwright's own |
| `E2E_LOGS` | keep every suite's log in this folder | temp folder, deleted at the end |
| `E2E_SHOTS` | where screenshots go | temp folder, deleted at the end |
| `E2E_WAIT` | idle seconds in the two `nav-preload` suites | 65 |
| `E2E_EXTRA` | one extra throwaway suite as `name\|file\|seed\|plain`, for probing | none |

`run.sh` refuses to start if port 27281, 3281 or 4401 is already in use, and only ever stops the processes it started.

## How it works

- One shared environment (database `workos_e2e`, test password `testpass-e2e-123`, test tokens) is exported by `run.sh`; the app and every suite read it. `lib.mjs` refuses to run unless `MONGODB_URI` points at localhost and the database name starts with `workos_e2e`.
- Every suite starts on an emptied database. `seed.mjs <profile>` empties all collections and then seeds one of: `none`, `base` (direct-insert fixtures for Review and search; also the notes and projects `dispatcher-backend-2` needs), `nav` (3 projects, 16 tasks, 2 Claude items waiting on Om), `today` (overdue / due-today tasks, 3 waiting items, a device with 2 sessions). Suites that need other data seed themselves.
- A suite prints `PASS` / `FAIL` lines and a final `RESULT pass=N fail=M` line, which `run.sh` reads. The assert-style suites (`review`, `search`, `settings`, `dispatcher-ui`) count each assertion as one check and stop at the first failed one.
- Browser suites cover phone (390 wide, touch) and desktop (1280 wide) inside the same file unless noted.

## Suites

| Suite | Seed | What it covers |
| --- | --- | --- |
| `today` | today | Today at 390 and 1280: first screen, Claude card (needs-you rows, reply, answered, activity line), Show more, Done and Undo, folds, no duplicate rows, 44px targets on phone, empty states |
| `claude-page` | none | `/claude` Now (Needs you, sessions), Queue (items, sheet), Setup (devices, folders, linking), Start Claude flow and its steps, at 1280 and 390 |
| `nav` | nav | Phone bottom bar (order, badges, lit tab, 44px), headers, Menu links and mode chips, `+` sheet, tab/segment switches use replace, Back rules; desktop sidebar (order, badges, Modes, footer clickable), keyboard shortcuts, help dialog, Back |
| `nav-cross` | nav | Start Claude modal from the `+` sheet, sidebar and key `S` on every main page, Back and Escape close it, old-URL redirects, no horizontal scroll on the main pages at 390 and 1280 |
| `nav-preload-1` | nav | After idling, Today to Projects to Tasks open from the preload (the only warmed pages); Menu and Settings open after one server round trip. Phone |
| `nav-preload-2` | nav | Today to Claude, the Claude Now/Queue/Setup tabs and the project overview tabs open (not prefetched in full any more: one server round trip allowed). Phone |
| `fix-check` | none | Sidebar footer reachable, theme toggle, Day plan dialog (desktop) and sheet (phone), named switches on Settings, Claude item sheet on a project page (note, state, Next) |
| `settings` | none | Redirects from `/connect` and `/recovery`, status strip, theme (one click), sections (alerts, security, connections, help), alerts table toggle persists, phone Back, no h-scroll |
| `review` | base | Old URLs redirect to `/review?view=...`, the six views (Done, Activity, Weekly, Stale, Archive, Trash), unarchive and Undo, new weekly review, entry from the sidebar and Menu |
| `search` | base | Global search: sign-in required, results, regex characters taken literally, `#ref` and item refs, project hits, keyboard (arrows, Enter, `/`, Ctrl+K) on desktop, phone sheet, 44px rows, 16px input, tap to open |
| `dispatcher-backend` | none | Claim on the worker poll (gates, cap, oldest first, one claim under concurrent polls), MCP cannot set or clear `claude`, outcomes (done, blocked, session dead, start failed), reconciler, alerts sent once |
| `dispatcher-backend-2` | none | Boilerplate note protected from MCP, restore strips `claude`, stale folder, alert text without mentions or links, repeated job failure ends as failed, status Om changed is kept, atomic job hand-out |
| `dispatcher-ui` | none | Give to Claude / Take back sheet (one folder, picker for two, refusals), row menus, badges, Claude's tasks section on `/claude`, dispatcher Setup switch (needs a note), alerts table lists the Claude kinds, at 1280 and 390 |
| `launcher-backend` | none | Worker API: key checks, folder validation and path rejection, remote clean-up, job isolation between devices, job hand-out and retry, status handling, rate limit |
| `usage` | none | Request log: auth unchanged on /api/mcp, /api/worker, /api/cron, /api/discord/interactions (still bypass the session check) and on guarded paths; counts per kind, caller and route; nothing raw stored; static files not counted; Settings › Usage at 390 and 1280 |
| `push` | none | Push streams (phase 5): who may connect to `/api/stream` (and that `/api/live` stays the plain liveness route) and `/api/worker/stream`; a write reaches the writer and teammates for shared work and nobody else for a private task or another organization; hints carry only a topic; a project made private reaches the teammate who loses it; an open Claude page shows a teammate's change without a reload; the real worker client gets a stop job pushed; removing a member closes their page and worker streams; request counts of an idle Claude page per hour, push off and on (`COUNT` lines) |
| `alerts-once` | none | Unblocked and Overdue alerts reach the inbox and Discord exactly once under concurrent flushes and cron runs (uses a small fake Discord API on port 4401; `run.sh` restarts the app with `DISCORD_API_BASE` pointing at it for this suite only) |

## Not covered here

The worker's own unit tests are separate: `node --test worker/test/*.test.mjs`. Type check and lint: `npx tsc --noEmit`, `npx eslint --quiet`.
