# Work state

## Now
- UX audit done (docs/ux-audit: crawl-a, crawl-b, analysis, proposal). Waiting on Om's yes to the proposal and its 5 questions; then build slice 1 (Claude area).
- Navigation shell built on branch ui-nav (phone bar, + sheet, Menu, Projects|Notes, modes as Tasks filter, sidebar, shortcuts, Back rules); waits on Om merging and reconciling with the /claude branch.
- Nothing in progress. Sessions list made clear (labelled buttons, Remove, closed in grey, waiting text) on 2026-10-15; waits on Om retesting live. Launcher live and tested by Om on his PC (Start, Remote Control, Stop) on 2026-10-15.

## Next
1. Om: on the live site, Settings → send test email (Gmail via ops.delpat, reset links to OWNER_EMAIL).
2. Om's yes on the ~/.claude/CLAUDE.md text (Claude items + `.workos.json`), then apply it.
3. Om's answers on AKAR items C20, C22, C23 (waiting on Om) and the C7/C8 conflict below.

## Later
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
