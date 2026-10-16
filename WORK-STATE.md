# Work state

## Now
- Task dispatcher v1 deployed 2026-10-16 (reviewed, review fixes in, UI suite 4/4). Waits on Om trying one small task.

## Next
1. Om: `node worker/worker.mjs install` one last time (supervisor, allowPrompts report, claude lookup retry, parent folders); link the terrah folder; in Claude › Setup pick the boilerplate note, turn the dispatcher on, Give to Claude on one small task.
2. Grammar pass (names, Back rule, confirms, other sheets close on phone Back).
3. Om: on the live site, Settings → This device → send test email (Gmail via ops.delpat, reset links to OWNER_EMAIL).
4. Om's yes on the ~/.claude/CLAUDE.md text (Claude items + `.workos.json`), then apply it.
5. Om's answers on AKAR items C20, C22, C23 (waiting on Om) and the C7/C8 conflict below.

## Later
- Dispatcher: the jobs hand-out (find, then mark taken) is not atomic, so two simultaneous polls of one computer could both receive the same job; the worker de-duplicates by job id — waits on a conditional hand-out.
- Dispatcher: desktop board cards (/tasks) show the Claude badge but have no Give to Claude button (rows on project, Today and Review have it) — waits on Om asking.
- Dispatcher: the stuck alert goes out once per claim, not again if the session wakes and goes quiet again — waits on Om wanting repeats.
- Dispatcher: Take back on a running task while the PC is off marks it stopped but the session keeps running until the worker next polls a stop job (it is best-effort) — waits on real use.
- Dispatcher: throwaway-DB suite lives in the scratchpad (dispatch-test.mjs, ui-test.cjs), not in the repo — waits on moving test suites into the repo.
- Nav shell must link `/claude` (badge from `needsYouCount()`), `?start=1` from the + sheet and sidebar — waits on the nav branch merging with ui-claude.
- Project Claude card header summary can truncate ("1 queu…") on 390px when 3 parts show — waits on Om noticing.
- Setup does not yet list a computer's reported folders with link state (proposal §2.2) — waits on Om wanting it.
- A Remove-all-finished button for sessions — waits on Om finding one-by-one Remove tedious.
- AKAR C8 (debt step 3) is blocked by C7 in Work OS, but pms-89 said it is active in wt/debt-3 — waits on Om choosing one.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on a free slot.
- Project edits by Claude Code don't notify Om (only task changes do) — waits on Om saying whether he wants that.
- test-batch.mjs expects a "Delpat" project the seed doesn't create — waits on next test cleanup.
- A Connect tab tapped within ~1 s of the previous tab switch isn't preloaded yet (waits on the server) — waits on Om noticing it in use.
- Test suites need the throwaway mongod as a single-node replica set (transactions) — waits on next test cleanup (document in .scratch-mongo).
- Launcher Resume opens a new window each time instead of reusing one — waits on real use by Om.
- Worker logged one "fetch failed" during the real test (no effect) — waits on seeing it again.
- The repo moved to the project root on 2026-10-15; an empty `work-os` folder may remain (locked by an editor) — delete it when Om renames the folder to "work os" (.scratch-mongo start.sh/rebuild.sh hold the full path).
- Sessions shows Start only after a folder is linked; could always show Start and open the folder picker first — waits on Om's yes.
- After merging ui-nav: swap lib/data/nav-counts.ts claudeWaitingCount for needsYouCount(); point the Start Claude buttons at the real modal (they only add ?start=1); /claude lights its tab once the page exists — waits on the /claude branch merge.
- Old route names kept (/timetable, /notifications); only nav labels follow the glossary — waits on a route rename slice.
- Review hub (ui-settings): /history, /hidden and /archive are 307s to /review?view=; they keep the old ?tab= in the URL (harmless). A bookmark of the old /review (Weekly review) now opens Done — waits on Om noticing. Trash Restore has no Undo (a restore can't be undone without re-deleting) — waits on Om wanting it.
- /modes/<bad-slug> returns 200 (not-found streams after loading.tsx) — waits on a not-found check before the shell streams.
- Activity counts: a subagent silent for >2 min drops out of the count; terminal and macOS session shapes only tested on stubs — waits on Om's real use.
- Scratch suites in .scratch-mongo/scratchpad assume the old Connect code tab, a short seed2 fixture and a 'Notif' bell label — waits on next test cleanup.
- Today: Schedule button still opens the day plan dialog/sheet, not /timetable; "Full schedule" links to /timetable — waits on merging Schedule into one page.
- Today phone, worst case (3 waiting + 7 overdue): Due today shows its title but the meta line is under the tab bar; "Show 4 more" caps Overdue at 3 on phone — waits on Om's first-use feedback.
- Desktop TaskRow done now has Undo (shared by every desktop list); recurring tasks undo only the finished one, same as phone — waits on Om noticing.
- Claude page named sessions (branch ui-claude2): needs Om to restart his worker for the session list; VS Code/terminal sessions without a session id in their arguments are matched to the newest unclaimed transcript (best effort) — waits on Om's real use.
- Claude Queue tab rows are unchanged (not made denser) — waits on Om's feedback after the Sessions redesign.
- Settings merge (branch ui-settings): /connect and /recovery are 307s in next.config but keep the old `?tab=` in the URL (Next passes the query through) — harmless, waits on Om noticing.
- Alerts table: channels are global, not per alert, so each alert row has one switch and the Push/Discord cells show whether it is delivered now; per-alert-per-channel choice needs a settings schema change — waits on Om wanting it.
- Connections cards fetch Discord status on every open of the section (network call, up to 5 s); cache it if Settings feels slow — waits on Om noticing.
- docs/HANDOVER.md still describes /connect in places (Connect page, Settings layout); update when the slice merges.
- Old e2e suites launcher-ui and claude-ui target the retired /connect and old Claude layout; adapted copy lives in scratchpad final/t/claude-new.mjs — waits on moving test suites into the repo.
- Tab prefetch added to Claude, project and Settings tabs; not yet measured with a slow server — waits on the next full test run.
- Connections sends MCP_TOKEN with the page (owner-only, behind sign-in, same as before); could fetch on reveal instead — waits on a security pass.
- Global search (ui-settings): matches title/#ref/C-ref/note text as substrings (no ranking or fuzzy match, 6 per group, 80 chars); task descriptions and comments are not searched — waits on Om's use.
- Vercel usage: worker polls cut ~3x on 2026-10-16 (30 s idle / 10 s busy, status every 110 s, dispatcher work skipped when off). os-delpat used more than work-os that week — waits on Om looking at os-delpat's usage.
