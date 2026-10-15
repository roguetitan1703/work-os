# Work state

## Now
- Waiting on Om: set up the launcher on his PC and try the first real Start.

## Next
1. Om: Connect → Devices → add his PC; run `node worker/worker.mjs setup` and paste the key; link a folder, Start. (setup built, not yet run against his real config)
2. Om: on the live site, Settings → send test email (Gmail SMTP via ops.delpat, reset links to OWNER_EMAIL).
3. Om's yes on the ~/.claude/CLAUDE.md text (Claude items + `.workos.json`), then apply it.
4. Om's answers on AKAR items C20, C22, C23 (waiting on Om) and the C7/C8 conflict below.

## Later
- AKAR C8 (debt step 3) is blocked by C7 in Work OS, but pms-89 said it is active in wt/debt-3 — waits on Om choosing one.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`) — waits on checking env expansion in user-scope MCP headers.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
- Desktop/phone parity re-check of quick add, import and day plan (phone versions are smaller) — waits on a free slot.
- Project edits by Claude Code don't notify Om (only task changes do) — waits on Om saying whether he wants that.
- test-batch.mjs expects a "Delpat" project the seed doesn't create — waits on next test cleanup.
- Lint errors: claude-items.tsx:51 and current-block-bar.tsx:18 (setState in effect), timetable/today/route.ts no-explicit-any ×3 — waits on next UI touch.
- A Connect tab tapped within ~1 s of the previous tab switch isn't preloaded yet (waits on the server) — waits on Om noticing it in use.
- Test suites need the throwaway mongod as a single-node replica set (transactions) — waits on next test cleanup (document in .scratch-mongo).
- Launcher Resume opens a new window each time instead of reusing one — waits on real use by Om.
- First Start in a new folder sits at claude's "trust this folder" prompt until answered in the terminal — waits on real use by Om.
- Worker logged one "fetch failed" during the real test (no effect) — waits on seeing it again.
- The repo moved to the project root on 2026-10-15; an empty `work-os` folder may remain (locked by an editor) — delete it when Om renames the folder to "work os" (.scratch-mongo start.sh/rebuild.sh hold the full path).
