# Work state

## Now
- "Fix all" from the 2026-10-15 sanity check (Om's go). Order below; each step built, tested, committed.

## Next
1. Speed: keep main pages + Connect tabs prefetched while the app is open (preloader; 2/4 checks passed, refresh before expiry still missing).
2. Claude Code oversight: notify on status/archive/restore/progress changes to Om's tasks; trash releases dependants and leaves a history line.
3. Alerts: per-kind channel choice honoured everywhere; queued "unblocked" flush sends only those, not the daily digest; one "untouched 7 days" rule; prune the inbox in the cron; security/test kinds listed.
4. MCP tools made consistent: batch ops share the single-tool schemas, one logProgress path, clearer descriptions (summary vs activity vs list), archive tool.
5. Claude items: separate list per project, claim on start, quality rules (clear on its own, min size, group small ones), read in get_project, one write tool, phone + desktop screens, "waiting on you" in the bell. Security review before merge.
6. Move examples/anaspure + wt/ana* from Brahmasuite to AKAR; import pms-89's 29 items (with its corrections); send pms-89 the tool names.
7. Screens: Settings = preferences/security, Connect = status/Claude/Discord/alerts; one "History & trash" row; one name per page; rename Hidden work → Untouched; bell on phone headers + unread count on desktop.
8. Delete leftovers: /api/tasks/uncompleted, unused UI components, legacy import code.

## Later
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Global `~/.claude/CLAUDE.md` session rule for Claude items (replaces the WORK-STATE line) — waits on Claude items being live, then Om's yes on the exact text.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on step 7.
