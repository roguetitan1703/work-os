# Work state

## Now
- 2026-10-23: Next 16.4.2 and the audit (builder B, ui-settings): next 16.2.4 to 16.4.2 (proxy bypasses, image/`use cache` RCE, server-action DoS, RSC cache poisoning), `npm audit --omit=dev` 26 to 2 (both @tailwindcss/typography's build-time postcss-selector-parser; the offered fix is a downgrade), shadcn moved to devDependencies, `images.unoptimized`. Red-team R2-01: nonce CSP on every page (proxy.ts), X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (next.config.ts), task links http(s)/mailto only on every path; e2e `headers` suite. Waiting on review and merge.
- 2026-10-23: multi-user load (builder B, ui-settings): a team of 20 measured with tests/load (simulated day) and fixed in cost order (links prefetch on hover only, Claude page on 'claude' hints only, indexes, list-shaped tasks, no refresh after revalidating actions): CPU per thing done 3.4x less, requests per user-hour 588 to 87, a day 4% of a t3.small's baseline (docs/cpu.md "Multi-user"). Budgets suite in tests/e2e/run.sh. Waiting on review and merge.
- 2026-10-22: multi-user Work OS, own sign-in first (Om); Delpat OS integration later. Plan: docs/multi-user.md. Phases 0 (CPU), 1 (sign-in, docs/auth.md) and 2 (ownership, re-reviewed safe) merged to master. Phase 3 (per-user settings: schedule, routine, modes and review as data; timezone and quiet hours per person; Discord linked per person; "Om" out of code) merged (security review fixes in). Phase 4 (team: members and roles, removal, assignees, Assigned to me, the invitation-link switch; plus the phase 2 review leftovers) merged (security review fixes in). Phase 5 code merged: deploy kit (docs/hosting.md, deploy/, scripts/cutover.sh, rehearsed on a throwaway copy) and push (SSE streams replace polling). The move itself (EC2 at work.delpat.in, with Akash) waits on Om: the server, DNS, Atlas access, S3, SMTP and env values (docs/hosting.md lists them), and his go for the cut-over (scripts/cutover.sh runs every migration step in order).
- 2026-10-23: leak audit on builder-a (tests/e2e/leak-audit.mjs, every entry point as owner, teammate, other organization, removed member and nobody; docs/multi-user.md "Leak audit"). Two fixes in it: server actions and POST routes read the session from the database (a cookie copied before sign-out could write for 2 minutes), and another organization's invitation id answers "not found" (cancel-invitation over HTTP no longer served). Waiting on its security review and merge.
- 2026-10-22: phase 5 deploy kit built on builder-a (docs/hosting.md, deploy/, scripts/cutover.sh; cut-over rehearsed on a throwaway database, 25/25 checks), waiting on review and merge, then on Akash's server and Om's go.
- 2026-10-22: phase 5 push, the code part (SSE streams for pages and workers, fan-out in the data door; docs/multi-user.md "As built: phase 5 push", nginx in docs/hosting.md §12 and deploy/nginx/work-os.conf) on ui-settings, rebased on the deploy kit, waiting on its security review (auth on the streams, who gets hints).
- 2026-10-19: Vercel paused Om's account (Fluid Active CPU); Work OS moves to Delpat's AWS server (work.delpat.in). Audit summary in docs/multi-user.md.

## Next
Phases 0 to 5 in docs/multi-user.md, in order. The C46–C52 items below wait until Work OS runs again.
Open work is filed as Claude items on Work OS (Claude page › Queue); this list only orders it.
1. C46 (Om): first real dispatcher task — Claude › Setup: pick the boilerplate note, turn the dispatcher on, Give to Claude on one small task.
2. C51 (Om): Settings › This device › Send test; report which channels arrived.
3. C48 (Om): yes on the ~/.claude/CLAUDE.md text (draft in the item's note), then apply it; then C49 (one line per repo CLAUDE.md).
4. C50 grammar pass; C52 small fixes and checks.
5. C47 cloud sessions via a Routine, after C46 works.
6. Om's answers on AKAR items C20, C22, C23 and the C7/C8 conflict (below).

## Later
- A save (server action) reads the session from the database twice: once for the action and again for the page it re-renders in the same request (both carry the action header), about 6 database operations per save; the Tasks update budget was raised from 16 to 24 for it — waits on a per-request memo of the fresh session.
- e2e: alerts-once, dispatcher-backend and dispatcher-backend-2 fail when run between about 23:00 and 09:00 IST (the test owner's default quiet hours, and due/overdue alerts only go out after the morning hour); seen in the leak-audit run at 01:50 IST — waits on someone running the suites at night again (give those owners no quiet hours and a fixed clock).
- Leak audit: two MCP writes to the same task at the same moment fail with MongoDB's "Write conflict during plan execution … Please retry" text instead of being retried (seen when the owner's calls ran side by side) — waits on it happening in real use.
- Leak audit: `dispatcherSetupAction` (app/(app)/claude/dispatcher-actions.ts) is a server action nothing imports, so it is not in the build — waits on someone touching that file (delete it or use it).
- Leak audit: search for "#1" also lists #10–#19 (it matches the number as text) — waits on Om noticing.
- Load: links now prefetch on hover/focus/touch only (components/intent-link.tsx); on phones a tap on a page the preloader has not warmed waits one round trip — waits on Om noticing it on the phone.
- Load: the Claude page refreshes on 'claude' hints only; a task given to Claude sends one when the write touches its `claude` mark, but editing such a task's title or status without touching the mark does not refresh an open Claude page (Now tab shows the old title until the next refresh) — waits on Om noticing.
- Load: router.refresh() is still called after actions in project header/top, review unarchive, trash, settings (Discord, notices, time), note editor, mobile day plan, import, quick add and the 1.2 s refresh after completing on a phone row; each costs one extra page fetch per write — waits on a sweep with a visual check on the phone.
- Load: the preloader still warms Today, Tasks and Projects every 5 minutes while a tab is in use (36 requests an hour; all of an idle in-use Claude page's requests) — waits on warming only after a hint.
- Load: /tasks and /projects examine every task of the organization (about 1,800 documents each for 2,000 tasks; counts per project and open filters run over the org index); fine on Atlas at 2,000 tasks — waits on an organization with far more tasks (then a { orgId, status } index or stored counts).
- Load: /api/admin/health shows open streams but not memory or event-loop lag — waits on the box (add process.memoryUsage and a loop-delay histogram if journal and systemctl are not enough).
- Push: signing out elsewhere or revoking one session does not close that session's open streams; they keep getting topic-only hints for up to 30 minutes (the stream lifetime) — waits on session-revoke hooks (Better Auth) to call the hub.
- Phase 5: the nginx site, systemd units, deploy.sh, backup.sh and cron-alerts.sh are only syntax-checked (no Linux on the dev PC) — waits on the first run on the server; fix in the repo.
- Phase 5: Settings status "Server" row and /api/admin/health read Vercel's variables, so on EC2 they say "development · local" and VERCEL_ENV null — waits on the move (show the release commit from REVISION instead).
- Phase 5: HANDOVER still describes Vercel (live URL, "pushing to master deploys", cron-job.org, Vercel env), and so do Settings › Alerts (setup guide: "add CRON_SECRET in Vercel", cron-job.org) and the status row hint — waits on the move; then point them at the server timer and docs/hosting.md.
- Phase 5: the alerts cron's 03:00 UTC prune runs only if a run lands in 03:00–03:15 UTC; the timer runs at :00, so it does, but a missed run skips that day's prune — waits on it mattering.
- Push: the hub (lib/live.ts) is in memory in one process; a second app instance would not hear the first one's writes — waits on running more than one instance (then Redis pub/sub or MongoDB change streams).
- Push: only the Claude page listens. Today, Tasks, Projects, a task page, Notifications and the layout badges still show changes on the next tap or refresh (one line each: `subscribe` from components/live.ts, as AutoRefresh does) — waits on Om wanting live pages.
- Push: the preloader still warms Today, Tasks and Projects every 5 min while a tab is in use (36 requests an hour, now all of an in-use Claude page's cost); it could warm only after a hint — waits on docs/cpu.md work.
- Push: writes outside the door send no hint unless they call hint()/wake() (settings such as the dispatcher switch in another tab, members and roles, computers added or revoked, Discord links) — waits on someone noticing a page not following.
- Push: a computer going online or offline does not hint the Claude page (shown at its next refresh) — waits on Om noticing.
- Push: a session signed out elsewhere keeps its page stream until the 30-minute reconnect (it carries only topic hints, and the refresh it triggers is refused) — waits on it mattering.
- Push: a change in the ~1 s between a Claude page render and its stream connecting is shown only at the next hint or tab return — waits on someone seeing it.
- Stale page after a write, outside the Claude page: Next 16.2.4 (React 19.3 canary) sometimes leaves a server action's new page waiting until another React update. The Claude page works around it (write() in claude/auto-refresh.tsx); other pages still call router.refresh() after revalidating actions (task rows, task detail, trash, quick add, day plan) and can show the old data until the next tap — waits on someone seeing it there. On Next 16.4.2 the claude-page suite passed twice (150/150 each) with write()'s re-render switched off (16.3 fixed "navigation reverted while a Server Action is in flight"), but the bug was intermittent, so write() stays — waits on more runs without it (then drop it and the note in HANDOVER §12).
- Every revalidating action drops the whole client prefetch cache, and each visible link is prefetched again (about 15 small requests after one Move on the Claude page, seen in the stale-list probe) — waits on docs/cpu.md work (fewer prefetching links, or revalidating less).
- Phase 3: no editor for an organization's modes (the default eight, or what migrate-phase3 seeds); colours for non-mode block names, which mode fills a block, review questions and help sections have no editor either (data only) — waits on Om wanting to change them in the app.
- Phase 3: one routine per person; the timetable editor has no per-block colour — waits on someone needing a second routine.
- Personal settings docs are keyed `<area>:<userId>` (lib/scope.ts setUserSetting, from phase 2), so a write in another organization moves profile, schedule, dispatcher and the Discord link to that organization (phase 3 security review). Fix: key them `<area>:<orgId>:<userId>`, or refuse a write across organizations — waits on phase 4 or a second organization in real use.
- Clearing a cache clears it on one server instance only: another instance stays stale for 60–90 s after an unlink, a member removal or a new block (phase 3 security review) — waits on phase 5 (one server, or push).
- When a modes editor ships, mode names and descriptions go into the MCP instructions: a prompt-injection path from any admin to every member's Claude (phase 3 security review) — waits on the modes editor; quote or limit them then.
- Phase 3: Discord private threads are shown only to a server administrator (membership needs a call per thread) — waits on someone missing one.
- Phase 3: only the operator sets an organization's Discord server and registers its commands (again after the modes change) — waits on organizations managing their own bot.
- Phase 3: the MCP argument `waiting_on_om` keeps its name (renaming breaks connected clients) — waits on a tool-version bump.
- Phase 3: a task keeps a mode its organization later drops (only new or changed modes are checked) — waits on a modes editor.
- In-memory caches are per server instance: a role change, removal or rename shows at once on the instance that made it and within a minute on others (memberNames and the role cache now live on globalThis, so every bundle in one process shares them). With more than one instance a removed person keeps working for up to about a minute (role cache 60 s, cookie cache 120 s); hosting is one EC2 server, so no fix now — waits on running more than one instance.
- Phase 4: a removed member's shared tasks keep them as owner; unassigned, their alerts go to nobody (the cron runs per membership). Fix: hand them to the remover, or prompt to reassign — waits on Om saying which.
- Phase 4: a removed member's computers are revoked, so a Claude session already running on their PC is not stopped by Work OS (no stop job reaches a revoked computer); its key is dead, so it can no longer read or write Work OS — waits on it mattering.
- Phase 4: `INVITE_LINK_TO_INVITER=0` (links by email only) has no e2e test (the suites share one server started without it); its code path is small — waits on Om choosing it.
- Phase 4: two owners demoting each other at the same moment is handled (the demotion is checked after the write and undone if it left no owner) but not e2e-tested — waits on it mattering.
- Phase 4: task rows (lists, board, Today) don't show who is assigned; only the task page, Assigned to me and MCP do. Quick add, Discord /task and import have no assignee syntax — waits on Om wanting them.
- Phase 4: daily_summary does not split out what is assigned to you (list_tasks assignee:"me" does) — waits on Om's morning brief needing it.
- Operator by email: an admin who invites an address in OPERATOR_EMAILS that has no account yet makes that invitee an operator (invites set emailVerified) — create operator accounts before inviting anyone (deploy step above).
- Take back on a legacy running Claude task (no marker) lets anyone mark it stopped; the session keeps running — goes away after the migration (no legacy marks) .
- CPU leftovers (docs/cpu.md): /today sends every open task in full; /today and /claude run claudeOverview (~12 reads, now only when /claude gets a hint); dispatcher settings and device key are read on every worker poll (now every 5 min with push) — wait on a smaller task shape for the client.
- Menu, Settings, Claude and their tabs wait for a server round trip on first tap now (only Today, Tasks, Projects are warmed) — waits on Om noticing it in use.
- Auth phase 1: the migration revokes old worker computers instead of giving them to Om — waits on Om saying whether to keep them.
- Auth phase 1: password reset no longer asks for the authenticator code (the old flow did) — waits on Om saying whether he wants it back.

- Auth phase 1: a revoked session or removed member can open pages for up to 2 min (cookie cache); actions and data reads check the database — waits on Om finding 2 min too long.
- Auth phase 1: invitation link is shown to the inviter; an admin could claim the invitee's account. Phase 4 made it one switch: `INVITE_LINK_TO_INVITER=0` sends links by email only (default unchanged: shown) — waits on Om choosing.
- Two visible projects can share a name (your private one and a teammate's later shared one); a lookup by name picks your private one — waits on Om finding it confusing.
- OPERATOR_EMAILS must be set on the server, or nobody gets health, Usage, Discord registration or the organizations' Discord server setting — set it with the deploy.
- Old documents are invisible between deploying phase 2 and running scripts/migrate-ownership.mjs (no orgId) — run the migration right after the deploy.
- Usage log cannot tell prefetches from page data (Next 16 hides the prefetch headers from the proxy; skipProxyUrlNormalize would change what the auth check sees) — waits on Om needing that split.
- Dispatched sessions (wt tab, prompt as first argument) leave no transcript in ~/.claude/projects, so the Sessions list shows the folder name, no title, no subagents, and the stuck alert has no lastActiveAt — waits on finding where that Claude Code version writes them.
- A dispatched session waits forever at a permission question (seen on the demo: a phone check, a git commit with a $(…) message); only the 20-min stuck alert says so — waits on Om choosing a permission mode for dispatched sessions.
- Finishing a task given to Claude also sends "Claude Code changed #12" next to "Claude finished #12" (complete_task on a task Claude did not create) — waits on Om saying whether to drop it for dispatched tasks.

- Dispatcher: the stuck alert goes out once per claim, not again if the session wakes and goes quiet again — waits on Om wanting repeats.
- Dispatcher: Take back on a running task while the PC is off marks it stopped but the session keeps running until the worker next polls a stop job (it is best-effort) — waits on real use.
- Project Claude card header summary can truncate ("1 queu…") on 390px when 3 parts show — waits on Om noticing.
- Setup does not yet list a computer's reported folders with link state (proposal §2.2) — waits on Om wanting it.
- A Remove-all-finished button for sessions — waits on Om finding one-by-one Remove tedious.
- AKAR C8 (debt step 3) is blocked by C7 in Work OS, but pms-89 said it is active in wt/debt-3 — waits on Om choosing one.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on a free slot.
- Project edits by Claude Code don't notify Om (only task changes do) — waits on Om saying whether he wants that.
- A Connect tab tapped within ~1 s of the previous tab switch isn't preloaded yet (waits on the server) — waits on Om noticing it in use.
- Launcher Resume opens a new window each time instead of reusing one — waits on real use by Om.
- The repo moved to the project root on 2026-10-15; an empty `work-os` folder may remain (locked by an editor) — delete it when Om renames the folder to "work os" (.scratch-mongo start.sh/rebuild.sh hold the full path).
- Sessions shows Start only after a folder is linked; could always show Start and open the folder picker first — waits on Om's yes.
- Old route names kept (/timetable, /notifications); only nav labels follow the glossary — waits on a route rename slice.
- Review hub (ui-settings): /history, /hidden and /archive are 307s to /review?view=; they keep the old ?tab= in the URL (harmless). A bookmark of the old /review (Weekly review) now opens Done — waits on Om noticing. Trash Restore has no Undo (a restore can't be undone without re-deleting) — waits on Om wanting it.
- /modes/<bad-slug> returns 200 (not-found streams after loading.tsx) — waits on a not-found check before the shell streams.
- Activity counts: a subagent silent for >2 min drops out of the count; terminal and macOS session shapes only tested on stubs — waits on Om's real use.
- Today: Schedule button still opens the day plan dialog/sheet, not /timetable; "Full schedule" links to /timetable — waits on merging Schedule into one page.
- Desktop TaskRow done now has Undo (shared by every desktop list); recurring tasks undo only the finished one, same as phone — waits on Om noticing.
- Claude Queue tab rows are unchanged (not made denser) — waits on Om's feedback after the Sessions redesign.
- Settings merge (branch ui-settings): /connect and /recovery are 307s in next.config but keep the old `?tab=` in the URL (Next passes the query through) — harmless, waits on Om noticing.
- Alerts table: channels are global, not per alert, so each alert row has one switch and the Push/Discord cells show whether it is delivered now; per-alert-per-channel choice needs a settings schema change — waits on Om wanting it.
- Connections cards fetch Discord status on every open of the section (network call, up to 5 s); cache it if Settings feels slow — waits on Om noticing.
- Global search (ui-settings): matches title/#ref/C-ref/note text as substrings (no ranking or fuzzy match, 6 per group, 80 chars); task descriptions and comments are not searched — waits on Om's use.
- Vercel usage: worker polls cut ~3x on 2026-10-16 (30 s idle / 10 s busy, status every 110 s, dispatcher work skipped when off). os-delpat used more than work-os that week — waits on Om looking at os-delpat's usage.
- Worker log shows short "fetch failed" bursts (mostly at night / around restarts); it retries and recovers — waits on it causing a missed job.
- Audit: `npm audit --omit=dev` still lists @tailwindcss/typography 0.5.20 → postcss-selector-parser 6.0.10 (moderate, quadratic selector parsing). It runs only in the build, on our own CSS; npm's fix is a downgrade to 0.5.4 — waits on a typography release on postcss-selector-parser 7.
- CSP: pages that are still prerendered (`/_global-error`) carry no nonce, so with the page CSP their inline scripts would not run if Next served that static copy; not seen (global errors render per request) — waits on someone seeing a blank global error page.
- CSP: a new third-party script, frame, font or upload host (S3 for note files after the move off Vercel Blob) needs a line in `pageCsp` (proxy.ts) or it is blocked — waits on the note-files move.
- Next 16.4: `next dev` writes a managed block into AGENTS.md when it detects a coding agent (`agentRules`, on by default); leave it or set `agentRules: false` — waits on Om seeing the diff.
