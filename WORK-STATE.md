# Work state

## Now
- Building the approved UX proposal (docs/ux-audit/proposal.md): branch ui-claude (/claude area: Now, Queue, Setup with keys and computers; Start Claude modal) and branch ui-nav (bottom bar Today·Projects·+·Claude·Tasks, Menu replaces More, sidebar, modes as a Tasks filter, back rules). Om's answers 2026-10-15: tapping a project opens a modal (no instant start); yes to modes filter, Claude › Setup, Today without tiles.

## Next
1. Merge ui-claude then ui-nav; full suites; deploy.
2. Slice 3: project page as an overview. Slice 4: Today rebuilt. Then Settings merge, Review hub, grammar pass, global search.
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
