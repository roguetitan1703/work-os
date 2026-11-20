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
| `nav` | nav | Phone bottom bar (Today, Projects, +, Needs, Claude; badges, lit tab, 44px), one header on every page (search, bell, Menu, the one back link), the flat Menu, `+` sheet (Start Claude, New note), no second + on Projects, tab/segment switches use replace, Back rules, `/modes/*` gone; desktop sidebar (order, one badge colour, the bell, account menu with Review, Schedule, What's new, Settings), keyboard shortcuts 1-6, help dialog, Back |
| `nav-cross` | nav | Start Claude modal from the `+` sheet, sidebar and key `S` on every main page, Back and Escape close it, old-URL redirects, no horizontal scroll on the main pages at 390 and 1280 |
| `nav-preload-1` | nav | After idling, Today to Projects opens from the preload; Menu, Menu › Tasks and Settings open within one server round trip. Phone |
| `nav-preload-2` | nav | Today to Claude, the Claude Now/Queue/Setup tabs and the project overview tabs open (not prefetched in full any more: one server round trip allowed). Phone |
| `fix-check` | none | Sidebar footer reachable, theme toggle, Day plan dialog (desktop) and sheet (phone), named switches on Settings, Claude item sheet on a project page (note, state, Next) |
| `settings` | none | Redirects from `/connect` and `/recovery`, status strip, theme (one click), sections (alerts, security, connections, help), alerts table toggle persists, phone Back, no h-scroll |
| `review` | base | Old URLs redirect to `/review?view=...`, the six views (Done, Activity, Weekly, Stale, Archive, Trash), unarchive and Undo, new weekly review, entry from the sidebar and Menu |
| `search` | base | Global search: sign-in required, results, regex characters taken literally, `#ref` and item refs, project hits, keyboard (arrows, Enter, `/`, Ctrl+K) on desktop, phone sheet, 44px rows, 16px input, tap to open |
| `dispatcher-backend` | none | Claim on the worker poll (gates, cap, oldest first, one claim under concurrent polls), MCP cannot set or clear `claude`, outcomes (done, blocked, session dead, start failed), reconciler, alerts sent once |
| `dispatcher-backend-2` | none | Boilerplate note protected from MCP, restore strips `claude`, stale folder, alert text without mentions or links, repeated job failure ends as failed, status Om changed is kept, atomic job hand-out |
| `dispatcher-ui` | none | Give to Claude / Take back sheet (one folder, picker for two, refusals), row menus, badges, Claude's tasks section on `/claude`, dispatcher Setup switch (needs a note), alerts table lists the Claude kinds, at 1280 and 390 |
| `launcher-backend` | none | Worker API: key checks, folder validation and path rejection, remote clean-up, job isolation between devices, job hand-out and retry, status handling, rate limit |
| `subtasks` | none | Subtasks (docs/subtasks.md): a parent and its subtasks in one MCP call (add_task, apply_changes with "$name"), rollup numbers (Done 100, Dropped left out), one level only, a subtask stays in its parent's project, moving the parent moves them and who sees them, complete_task leaves open subtasks open and lists them, trash and restore together, recurring parent, rename and detach; the task page section, board chip and "in" line and the "Close the N open subtasks too?" question at 1280; the section, list row, 44px tick and Leave them open at 390 |
| `usage` | none | Request log: auth unchanged on /api/mcp, /api/worker, /api/cron, /api/discord/interactions (still bypass the session check) and on guarded paths; counts per kind, caller and route; nothing raw stored; static files not counted; Settings › Usage at 390 and 1280 |
| `push` | none | Push streams (phase 5): who may connect to `/api/stream` (and that `/api/live` stays the plain liveness route) and `/api/worker/stream`; a write reaches the writer and teammates for shared work and nobody else for a private task or another organization; for a project shared with chosen people only its list (taken off or put on: a hint); hints carry only a topic; a project made private reaches the teammate who loses it; an open Claude page shows a teammate's change without a reload; the real worker client gets a stop job pushed; removing a member closes their page and worker streams; request counts of an idle Claude page per hour, push off and on (`COUNT` lines) |
| `live` | none | Live pages: Tasks (list), Today, Projects, a project page and a task page show a teammate's MCP change, the person's own Claude's change and a change from their second session without a reload; a burst of 6 writes is at most 2 refreshes; no refresh while typing in a field (caught up on leaving it, the draft kept); a hidden tab catches up when shown; the unread badge follows an assignment; an edit in the tab costs no extra page fetch; at 390 and 1280 |
| `sharing` | none | Shared / Private projects from the app: the new-project choice (desktop and phone), switching on the Info tab (owner only; the confirm names who loses access and assignments), the Private badge, and what a teammate sees at each step; sharing with chosen people (Everyone / Choose people, the list and its confirm, who has access, the people badge, assignees on the list only, owner-only, back to everyone) |
| `oauth` | none | OAuth sign-in for MCP clients (docs/auth.md "Connecting Claude with OAuth"): discovery (401 + `WWW-Authenticate`, protected-resource and authorization-server metadata), dynamic registration and what it refuses, authorization code + S256 PKCE through the real sign-in and consent pages (Allow, Deny, tampered requests, not frameable), token exchange, `tools/list` and scoped tools with the token, refresh and rotation, reuse detection, revocation (endpoint and Settings), a removed member's token, another organization, the chat / Claude Code split, endpoints that must stay 404 |
| `oauth-limits` | none | Rate limits on `/oauth2/register` (20 an hour) and `/oauth2/token` (30 a minute); needs Better Auth's limits on: `E2E_AUTH_RATE_LIMIT=on bash tests/e2e/run.sh oauth-limits` (passes as skipped otherwise) |
| `budgets` | none (seeds the load team) | Cost budgets (`tests/load/budgets.json`, docs/cpu.md "Multi-user"): per request kind KB, database operations, documents examined and no collection scans; requests per step of a real tab; requests in an idle hour of the Claude and Today pages and a worker; a minute of the whole team per user-hour. A FAIL names the route, metric, budget and actual |
| `headers` | none | Security headers (red-team R2-01): a nonce Content-Security-Policy on every page and on every inline script, the static headers (frame, nosniff, referrer, permissions), `/_next/image` off; no CSP violation on Today, a task, a note (BlockNote), Settings, Claude and Tasks; `javascript:`, `data:`, `vbscript:` and `file:` task links refused through MCP (add, update, batch) and the task page |
| `flow-n1` | none | Needs (docs/flows/plan-1-3.md slice 4), flow N1: `ask` from a key and from the connector (the word is set by the server), one alert per Need under overlapping flushes and cron runs, a second Need of the same kind on the same task replaces the first, "Needs you" on Today and "Needs <name>: <ask>" on the task row (desktop and phone), `needs` and `withdraw_need`, limits (a `to` who cannot read the project refused, the 6th open Need refused), a task waiting on a Need is not "stalled", no tool answers a Need |
| `flow-n2` | none | Needs, flow N2: answering in the app (desktop and phone) records option, note, who, via "app", when and the wait time; the task gets its percent back; the asker reads the answer through `needs`; a teammate sees a Need read-only; an answered Need cannot be withdrawn |
| `flow-n3` | none | Needs inside slice 1: start_work lists answered then open Needs (once, session-matched, never another key's), the forYou line ("your Need #N was answered", "1 Need for you", ids only), State Next lines get waitsOn from open Needs (read-side), and the 5-open limit holds when eight asks race |
| `flow-n4` | none | Needs, security review: a moved task takes its Needs (shared/private/list, subtasks) and withdraws those the addressee cannot read; the hourly cap and alert damping; withdraw_need by word and session; chat only through OAuth; lost access withdraws; mark not writable; trash and restore; two answers at once |
| `flow-r1` | none | Results and review (slice 5): every path to Done for an agent (update_task, log_progress, apply_changes ops, complete_task, hand_in) gives a review Need on code, data and client work; check, report and no kind finish; Accept, Send back (line first in get_task and start_work, dispatched task re-queued) and Accept and file what is left, from the app; the outcome is recorded; one alert not two; a person still finishes directly; an agent cannot loosen the kind |
| `alerts-once` | none | Unblocked and Overdue alerts reach the inbox and Discord exactly once under concurrent flushes and cron runs (uses a small fake Discord API on port 4401; `run.sh` restarts the app with `DISCORD_API_BASE` pointing at it for this suite only) |
| `flow-b4` | none | The personal daily digest (flow B4, plan slice 2), through the cron's `?at=`: one digest per person with finished runs, due and overdue, gone quiet and moved yesterday in that order and the first-digest line; a second run the same day sends nothing; a task that turns overdue later alerts on its own; quiet hours hold it; a later `digestHour` holds it; digest off keeps the old morning alerts; a private project of someone else never appears; the next day's digest has no first-digest line |
| `flow-dc1` | none | Answering a Need from its Discord DM (flow DC1, plan slice 6): the DM has one button per option (custom id `wo:need:<id>:<option>`), an app-only Need has a link and no buttons; a signed DM press (no server, only `user`) by the addressee answers once with via discord (three presses at once: one wins); another member, an unlinked account, a missing Need, an app-only Need, a bad option and a press in a server are refused; a private project's Need never reaches the team channel |

## Not covered here

The worker's own unit tests are separate: `node --test worker/test/*.test.mjs`. Type check and lint: `npx tsc --noEmit`, `npx eslint --quiet`.
