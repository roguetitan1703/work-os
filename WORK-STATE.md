# Work state

## Now
- 2026-10-23: move Work OS to Delpat's server (t4g.small, Caddy, work.delpat.in, Atlas) for the Delpat team. Code side done and merged: multi-user phases 0–5, leak audit, load budgets, Next 16.4.2 + CSP/headers, Shared/Private projects (old projects migrate as private), dispatcher trust labels (only the giver's words instruct Claude), deploy kit fitted to the box (docs/hosting.md). Waits on Om: DNS for work.delpat.in, Atlas access + allowlist, env values, R2 bucket/token and age key for backups, the box steps in docs/hosting.md, then the cut-over (snapshot, copy run, apply).

## Next
0. OAuth sign-in for Claude (builder A, branch builder-a): built and tested on the PC (docs/auth.md "Connecting Claude with OAuth"); waits on its security review, the merge and the deploy, then Om adds the connector on claude.ai (URL `https://work.delpat.in/api/mcp`, sign in, Allow) and runs `claude mcp add` + `/mcp` in Claude Code. Keys stay under Settings › Connections › Advanced.
Phases 0 to 5 in docs/multi-user.md, in order. The C46–C52 items below wait until Work OS runs again.
Open work is filed as Claude items on Work OS (Claude page › Queue); this list only orders it.
1. C46 (Om): first real dispatcher task — Claude › Setup: pick the boilerplate note, turn the dispatcher on, Give to Claude on one small task.
2. C51 (Om): Settings › This device › Send test; report which channels arrived.
3. C48 (Om): yes on the ~/.claude/CLAUDE.md text (draft in the item's note), then apply it; then C49 (one line per repo CLAUDE.md).
4. C50 grammar pass; C52 small fixes and checks.
5. C47 cloud sessions via a Routine, after C46 works.
6. Om's answers on AKAR items C20, C22, C23 and the C7/C8 conflict (below).

## Later
- OAuth: never tried against the real claude.ai or the real Claude Code (the suite is a scripted client following Claude's documented flow: 401 + resource_metadata, dynamic registration, S256, loopback redirects); check the first real connection and the consent screen on the box, and that claude.ai accepts the metadata (resource = APP_URL/api/mcp exactly) — waits on the deploy.
- OAuth: claude.ai registers a new client on every connection, so Settings › Signed-in apps grows by one entry each time Om re-adds the connector (unused clients with no approval are deleted after 48 h; approved ones stay until revoked) — waits on it annoying (then group by name and redirect, or drop apps unused for 90 days).
- OAuth: expired access and refresh tokens, used authorization codes and the `oauthConsent` rows of deleted clients are never swept (small rows) — waits on volume (a prune beside the alerts cron).
- OAuth: the client-metadata-document way (CIMD, what Claude Code prefers) is not offered; Claude falls back to registration (docs/auth.md) — waits on registration being a nuisance.
- OAuth: registration's 20 an hour and the token endpoint's 30 a minute are per address and share one bucket without TRUST_PROXY=1 — set on the box (Caddy sets X-Real-IP); check there.
- OAuth: signing out of the browser or "sign out other devices" does not end an approved app; only Revoke, member removal and a password reset do (by design: the connection is not the browser session) — waits on Om wanting otherwise.
- OAuth: a person in two organizations approves each separately and picks by switching organization first; the consent screen names the organization but does not offer a switch — waits on a real second organization.
- Claude › Setup still creates Claude Code keys and the old connector guide is gone from Connections; the keys stay as the fallback — waits on OAuth proven with Claude Code, then remove the key path for Claude Code.
- Injection labels: the list and search tools (get_project, list_tasks, search, daily_summary, list_notes, recent_activity, Claude items, the Discord read tools) carry teammates' text without writtenBy labels (the fixed instructions line covers them in words only) — waits on the review saying which matter.
- Injection labels: an owner's edit launders text: once the owner edits a field (say a teammate's description), the whole field counts as the owner's, the teammate's words left in it included; notes keep only createdBy and updatedBy (labelled when either is someone else) — waits on per-span or per-block authors.
- Injection labels: projects from before nameBy count as named by their owner (a teammate's earlier rename is not known) — waits on it mattering (no shared projects predate the cutover).
- Deploy (A5): `work-os-deploy <commit>` and `--rollback` accept any older master commit whose build is still attested, so the box can be downgraded to an older (attested) build by whoever runs it or controls the build user's clone — waits on it mattering (then refuse a commit older than the live one unless --rollback names it).
- Give to Claude only warns when a teammate wrote part of the task; it does not refuse — waits on Om wanting a refusal (then: the owner re-saves the text as theirs first).
- Deploy: the Server build workflow, the attestation and the publish job have never run on GitHub (first push to master) — waits on the merge and push; check the first run's release assets and one deploy.
- Server kit: nginx site, systemd units, `deploy.sh` (download, checks, `--artifact`, `--build-here`, the memory cgroup), `preflight.sh` and the Server build workflow are only syntax-checked or tested in pieces on Windows (the tarball checks with fake builds; a prebuilt `.next` started after `npm ci --omit=dev`) — waits on the first run on the box and the first push to master; fix them in the repo.
- Backups: nightly encrypted dump to R2 is built and stub-tested (deploy/backup.sh, docs/hosting.md section 11) but not run against real mongodump, age, aws or R2 — waits on Om providing the R2 bucket + token (Object Read & Write, one bucket) + the age public key, then the setup steps (new user workos-backup, /etc/work-os/backup-env, bucket lock + lifecycle), one hand run, and a restore drill into a throwaway local mongod before the timer is enabled; the runuser path in cutover.sh step 0 is untested (no root on the dev PC).
- Backups: a failed backup raises no alert (only a failed systemd unit); could call the app's operator alert or an OnFailure unit — waits on the first weeks of nightly runs.
- Shared box: the Caddy site has no per-address rate limits (nginx had 30/min on /api/auth/ and 20 streams per address; stock Caddy has no rate limiting, a plugin means rebuilding the box's Caddy); Better Auth's limits and the app's stream caps remain — waits on Om deciding whether that is enough.
- Shared box: the memory caps (heap 288 MB, MemoryHigh 380M, MemoryMax 480M) are estimates from the PC load test, not measured on the box, which is already deep in swap — waits on the first weeks there (`systemctl status work-os`), then adjust.
- Shared box: a rollback needs GitHub and the build still published (newest 20 builds) — waits on it mattering (then keep the previous release's tarball on disk, about 100 MB, instead of its folder).
- Next upgrade (builder B, 16.4.2): run a release made with `npm ci --omit=dev` again (next.config.ts loads without dev packages; docs/hosting.md "What depends on the Next version") — waits on that merge.
- `typescript` is still installed by `npm ci --omit=dev` (shadcn and msw ask for it as a peer); shadcn is a CLI and could be a dev dependency — waits on someone trimming the runtime install.
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
- Sharing (c): claimFor reads tasks through the marker's own scope, so a private project's tasks are invisible to a former marker even with a leftover mark (tested: worker claims nothing); no extra query was added — nothing to wait on.
- Sharing: `updateProject` runs its own `updateOne` after the cascade (tasks, notes, Claude items already moved), so a failed project update leaves the cascade applied — waits on a transaction around it.
- Sharing: the confirm's impact list misses people who only created tasks or notes in the project (they still lose access) — waits on Om wanting a fuller list.
- Sharing: choosing Private in New project when a shared project of that name exists hands back the shared one (created: false, toast says it exists) — waits on Om noticing.
- Sharing: the impact list falls back to "Someone" when a member has no name (names fall back to email in memberNames, then to "Someone") — waits on it mattering.
- Private badge: not yet on the Claude page group headings (queue, now tab), note lists and note pages, or the Today Claude card; quick add has no private marker for project names — waits on Om noticing.
- Sharing: the confirm lists people assigned or who commented on tasks; people who only edited a note or watched are not named (they still lose access) — waits on Om wanting a fuller list.
- Sharing: after migrate-ownership every old project is private, so a teammate sees nothing until Om shares each (one by one in Project › Info) — waits on Om doing it after the move.
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
- Links stored before the scheme allow-list (2026-10-23) are not re-checked and render as `href` as stored; the page CSP stops `javascript:` running — waits on a render-time safeHref or a one-off cleanup at the move.
- Leak audit treats any empty digest as a client-only bailout; an error page with an empty digest would pass — waits on tying it to the 16.4 bailout marker.
- CSP connect-src allows any `*.blob.vercel-storage.com` host (a small way out for data) — waits on the note-files move off Vercel Blob.
- Deploy: the build user must have no cron, at, linger or login sessions (seal_release kills its processes once, then chowns); hosting docs should say so (nologin, no linger) — waits on the box setup.
- Trust labels: a Discord-made task's link label (channel/thread names) and its "From Discord message by …" activity note count as the member's text — waits on labelling Discord-sourced links and notes.
- Trust labels: when the owner removes some of a teammate's tags, tagsBy becomes the owner for the tags left — waits on per-tag authors.
- Trust labels: projects renamed by a teammate before nameBy existed count as named by their owner — waits on nothing (old data only; fades with renames).
- Dispatcher: a teammate's change to blockedReason, links or tags does not take a queued task back from Claude (title, description and checklist do); they are labelled — waits on Om wanting take-back on those too.
