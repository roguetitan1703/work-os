# Work state

## Now
- Deployed 2026-10-15: Claude area (/claude Now·Queue·Setup), Start Claude modal, new nav shell (phone bar, Menu, sidebar, shortcuts, Back), Claude activity counts (sessions + subagents per computer). Om must reinstall his worker for the counts.

## Next
1. Om: `node worker/worker.mjs install` (worker picks up trust + activity counts); live check of /claude and the new nav.
2. Slice 3: project page as an overview. Slice 4 (Today rebuilt) is on branch ui-today, awaiting merge. Then Settings merge, Review hub, grammar pass, global search.
3. Om: on the live site, Settings → send test email (Gmail via ops.delpat, reset links to OWNER_EMAIL).
4. Om's yes on the ~/.claude/CLAUDE.md text (Claude items + `.workos.json`), then apply it.
5. Om's answers on AKAR items C20, C22, C23 (waiting on Om) and the C7/C8 conflict below.

## Later
- Nav shell must link `/claude` (badge from `needsYouCount()`), `?start=1` from the + sheet and sidebar — waits on the nav branch merging with ui-claude.
- Project page still has its own per-folder Start sheet and Add a folder sheet (kept on purpose) — waits on the project overview slice.
- Setup does not yet list a computer's reported folders with link state (proposal §2.2) — waits on Om wanting it.
- Connect overview's Claude Code card now links to Claude › Setup; drop the card when Connect merges into Settings (slice 7).
- `/connect?tab=code|devices` redirect happens client-side after the page shell streams (loading.tsx), not as an HTTP 307 — waits on moving the redirect into next.config if it matters.
- Worker has no log file (stdout of the hidden run is lost), so jobs can only be traced from state.json — waits on Om wanting a log file (add to the install).
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
- Lint errors left: current-block-bar.tsx:18 (setState in effect), timetable/today/route.ts no-explicit-any ×3 — waits on next UI touch.
- Theme toggle's first click goes system → light, so nothing visibly changes — waits on the Settings merge slice.
- After merging ui-nav: swap lib/data/nav-counts.ts claudeWaitingCount for needsYouCount(); point the Start Claude buttons at the real modal (they only add ?start=1); /claude lights its tab once the page exists — waits on the /claude branch merge.
- Settings sections are not separate routes yet, so "settings section Back goes to Settings" has nothing to apply to; Connections back goes to Menu — waits on the Settings merge slice.
- Old route names kept (/history, /hidden, /review, /timetable, /notifications); only nav labels follow the glossary — waits on a route rename slice.
- /modes/<bad-slug> returns 200 (not-found streams after loading.tsx), same as the /connect client redirect — waits on moving redirects into next.config.
- Activity counts: a subagent silent for >2 min drops out of the count; terminal and macOS session shapes only tested on stubs — waits on Om's real use.
- Scratch suites in .scratch-mongo/scratchpad assume the old Connect code tab, a short seed2 fixture and a 'Notif' bell label — waits on next test cleanup.
- Today: Schedule button still opens the day plan dialog/sheet, not /timetable; "Full schedule" links to /timetable — waits on merging Schedule into one page.
- Today phone, worst case (3 waiting + 7 overdue): Due today shows its title but the meta line is under the tab bar; "Show 4 more" caps Overdue at 3 on phone — waits on Om's first-use feedback.
- Desktop TaskRow done now has Undo (shared by every desktop list); recurring tasks undo only the finished one, same as phone — waits on Om noticing.
- Claude page named sessions (branch ui-claude2): needs Om to restart his worker for the session list; VS Code/terminal sessions without a session id in their arguments are matched to the newest unclaimed transcript (best effort) — waits on Om's real use.
- Claude Queue tab rows are unchanged (not made denser) — waits on Om's feedback after the Sessions redesign.
