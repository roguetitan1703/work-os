# Work state

## Now
- "Fix all" from the 2026-10-15 sanity check: built and tested locally, waiting on the security review, then deploy + import.

## Next
1. Security review result → fix anything critical/high → deploy.
2. Live checks on prod: speed (first tap after 5 min idle), Connect tabs, Claude items screen, notices.
3. Import pms-89's 29 items to prod (import-items.mjs, MCP_TOKEN) and move examples/anaspure + wt/ana* from Brahmasuite to AKAR; tell pms-89 the tool names.
4. Propose the Claude items session rule for ~/.claude/CLAUDE.md to Om (exact text; his yes first).
5. Session launcher (agreed with Om 2026-10-15; his note "Claude Code session launcher"): device keys (jobs read + status write only) on Connect; worker scans allowed roots and reports folder name + id + remote/branch, never paths; Work OS suggests links by remote; Om links folders to projects by name; the worker writes `.workos.json` {project, folderId} into linked folders (git: added to .git/info/exclude, never committed), also right before the first Start; Start PMS → pick a folder when more than one → worker opens claude there with the project → Remote Control; resume on death, stop job; sessions shown per project with Claude items. Resolution order for any session: `.workos.json` → git remote/subdir/branch → ask Om. Drops stored absolute paths from code locations. Security review before merge.
6. Very last (Om, 2026-10-15): move the repo up so git sits at the project root ("work mode os" → Om renames it "work os"); keep .scratch-mongo out of the repo (gitignore or move it).

## Later
- Item 8 (AKAR debt step 3) is "blocked by step 0" but pms-89 says it is active in wt/debt-3 — waits on pms-89/Om choosing one.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on a free slot.
- Project edits by Claude Code don't notify Om (only task changes do) — waits on Om saying whether he wants that.
- test-batch.mjs expects a "Delpat" project the seed doesn't create — waits on next test cleanup.
- Launcher Stop kills claude, so its Windows Terminal tab stays open showing "process exited"; a clean exit would close it — waits on real use by Om.
- Launcher Resume opens a new window each time instead of reusing one — waits on real use by Om.
- Resume of a session with real work in it not yet tried on a real machine — waits on Om's first real use.
- claude-items.tsx:51 lint error (setState in effect) — waits on next UI touch.
