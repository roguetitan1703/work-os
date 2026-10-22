# Work state

## Now
- 2026-10-22: multi-user Work OS, own sign-in first (Om); Delpat OS integration later. Plan: docs/multi-user.md. Phases 0 (CPU), 1 (sign-in, docs/auth.md) and 2 (ownership, re-reviewed safe) merged to master. Phase 3 (per-user settings: schedule, routine, modes and review as data; timezone and quiet hours per person; Discord linked per person; "Om" out of code) merged (security review fixes in). On deploy (phase 5, with Om's go): set OPERATOR_EMAILS, create the operator accounts first, then migrate-auth, migrate-ownership (--copy-to rehearsal first) and migrate-phase3, register the Discord commands again, remove DISCORD_GUILD_ID and DISCORD_OWNER_ID.
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
- Claude page: after Move/Next/Remove in the queue or sessions list, the list sometimes stays stale (old order, disabled buttons, removed row still shown) until a reload, though the database is right; e2e now reloads to get past it. Suspect the 10 s auto-refresh racing the action's router.refresh (queue-tab.tsx does not await it and clears busy at once) — waits on a builder B slot.
- Phase 3: no editor for an organization's modes (the default eight, or what migrate-phase3 seeds); colours for non-mode block names, which mode fills a block, review questions and help sections have no editor either (data only) — waits on Om wanting to change them in the app.
- Phase 3: one routine per person; the timetable editor has no per-block colour — waits on someone needing a second routine.
- Personal settings docs are keyed `<area>:<userId>` (lib/scope.ts setUserSetting, from phase 2), so a write in another organization moves profile, schedule, dispatcher and the Discord link to that organization (phase 3 security review). Fix: key them `<area>:<orgId>:<userId>`, or refuse a write across organizations — waits on phase 4 or a second organization in real use.
- Clearing a cache clears it on one server instance only: another instance stays stale for 60–90 s after an unlink, a member removal or a new block (phase 3 security review) — waits on phase 5 (one server, or push).
- When a modes editor ships, mode names and descriptions go into the MCP instructions: a prompt-injection path from any admin to every member's Claude (phase 3 security review) — waits on the modes editor; quote or limit them then.
- Phase 3: Discord private threads are shown only to a server administrator (membership needs a call per thread) — waits on someone missing one.
- Phase 3: only the operator sets an organization's Discord server and registers its commands (again after the modes change) — waits on organizations managing their own bot.
- Phase 3: the MCP argument `waiting_on_om` keeps its name (renaming breaks connected clients) — waits on a tool-version bump.
- Phase 3: a task keeps a mode its organization later drops (only new or changed modes are checked) — waits on a modes editor.
- In-memory caches that live in a module are per bundle (route handlers, pages and actions can each have their own copy), so clearing one after a save does not clear the others; phase 3's profile, schedule and modes caches now live on globalThis, but memberNames and the role cache (lib/people.ts, lib/caller.ts) still don't (a rename or role change can take up to a minute to show) — waits on it being noticed, or phase 5's single server.
- Phase 2 review leftovers: a teammate editing a sub-page of a task's note (or deleting/restoring the note) does not take the task back from Claude (only the root note has taskId; walk up to the root); a queued-to-running race can miss a take-back; moving a project org→private onto a name you already use privately gives a 500 (unhandled E11000); restoreTask deletes the trash doc before inserting — waits on a builder A slot after phase 3.
- Operator by email: an admin who invites an address in OPERATOR_EMAILS that has no account yet makes that invitee an operator (invites set emailVerified) — create operator accounts before inviting anyone (deploy step above).
- Take back on a legacy running Claude task (no marker) lets anyone mark it stopped; the session keeps running — goes away after the migration (no legacy marks) .
- CPU leftovers (docs/cpu.md): /today sends every open task in full; /today and /claude run claudeOverview (~12 reads); dispatcher settings and device key are read on every worker poll — wait on a smaller task shape for the client, and on phase 5 (push instead of polling).
- Menu, Settings, Claude and their tabs wait for a server round trip on first tap now (only Today, Tasks, Projects are warmed) — waits on Om noticing it in use.
- Auth phase 1: the migration revokes old worker computers instead of giving them to Om — waits on Om saying whether to keep them.
- Auth phase 1: password reset no longer asks for the authenticator code (the old flow did) — waits on Om saying whether he wants it back.

- Auth phase 1: a revoked session or removed member can open pages for up to 2 min (cookie cache); actions and data reads check the database — waits on Om finding 2 min too long.
- Auth phase 1: invitation link is shown to the inviter; an admin could claim the invitee's account — waits on Om deciding whether admins are less trusted than owners.
- alertLog keys are per task (not per recipient): when phase 4 lets a task change assignee, the new recipient misses alerts already logged for that task — waits on phase 4 assignees.
- Tasks have assigneeId but nothing sets it yet (no UI or MCP arg), so every alert goes to the owner — waits on phase 4.
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
