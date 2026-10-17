# Work state

## Now
- 2026-10-17: demo copy for the cutroom Work OS film (brief and kit in cutroom films/demos/work-os; demo lives in D:\work-os-demo, own DB, ports 27291/3291, own worker with the new mcpConfig and sessionsInRootsOnly options). Filming the Give to Claude shot is also the first real dispatcher run (C46).
- Sprint closed 2026-10-16: launcher, UX redesign (Today, Claude area, project overview, nav shell, Settings merge, Review hub, global search), dispatcher v1, worker supervisor, fewer worker calls. Full e2e: 15 suites, 740 checks pass (`bash tests/e2e/run.sh`). Waits on Om's live checks below. Open work is filed as Claude items C46–C52 on Work OS (#121 and #122 closed).

## Next
Open work is filed as Claude items on Work OS (Claude page › Queue); this list only orders it.
1. C46 (Om): first real dispatcher task — Claude › Setup: pick the boilerplate note, turn the dispatcher on, Give to Claude on one small task.
2. C51 (Om): Settings › This device › Send test; report which channels arrived.
3. C48 (Om): yes on the ~/.claude/CLAUDE.md text (draft in the item's note), then apply it; then C49 (one line per repo CLAUDE.md).
4. C50 grammar pass; C52 small fixes and checks.
5. C47 cloud sessions via a Routine, after C46 works.
6. Om's answers on AKAR items C20, C22, C23 and the C7/C8 conflict (below).

## Later
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
- Connections sends MCP_TOKEN with the page (owner-only, behind sign-in, same as before); could fetch on reveal instead — waits on a security pass.
- Global search (ui-settings): matches title/#ref/C-ref/note text as substrings (no ranking or fuzzy match, 6 per group, 80 chars); task descriptions and comments are not searched — waits on Om's use.
- Vercel usage: worker polls cut ~3x on 2026-10-16 (30 s idle / 10 s busy, status every 110 s, dispatcher work skipped when off). os-delpat used more than work-os that week — waits on Om looking at os-delpat's usage.
- Worker log shows short "fetch failed" bursts (mostly at night / around restarts); it retries and recovers — waits on it causing a missed job.
