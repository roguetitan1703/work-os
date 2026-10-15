# Work state

## Now
- Deploy "fix all" + session launcher (merged on master, reviewed): full suites on a fresh DB + build, then push and live checks.

## Next
1. Live checks on prod: speed (first tap after 5 min idle), Connect tabs, Claude items screen, notices, Devices tab, project Sessions.
2. Import pms-89's 29 items to prod (import-items.mjs, MCP_TOKEN) and move examples/anaspure + wt/ana* from Brahmasuite to AKAR; tell pms-89 the tool names.
3. Om: add his PC under Connect → Devices, set up the worker (set-token, roots, install) and do the first real Start.
4. Propose the Claude items + `.workos.json` rule for ~/.claude/CLAUDE.md to Om (exact text; his yes first).
5. Very last (Om, 2026-10-15): move the repo up so git sits at the project root ("work mode os" → Om renames it "work os"); keep .scratch-mongo out of the repo.

## Later
- Item 8 (AKAR debt step 3) is "blocked by step 0" but pms-89 says it is active in wt/debt-3 — waits on pms-89/Om choosing one.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on a free slot.
- Project edits by Claude Code don't notify Om (only task changes do) — waits on Om saying whether he wants that.
- test-batch.mjs expects a "Delpat" project the seed doesn't create — waits on next test cleanup.
- claude-items.tsx:51 lint error (setState in effect) — waits on next UI touch.
- Launcher Resume opens a new window each time instead of reusing one — waits on real use by Om.
- First Start in a new folder sits at claude's "trust this folder" prompt until answered in the terminal — waits on real use by Om.
- Worker logged one "fetch failed" during the real test (no effect) — waits on seeing it again.
