# Work state

## Now
- Nothing in progress. Connect hub shipped (overview cards + tabs; tested 360/390/1280, light/dark; keys suite 48/0).

## Next
1. Confirm cron-job.org is calling /api/cron/alerts (Settings → Status "Last check" keeps moving) and that the test email arrived.
2. Global `~/.claude/CLAUDE.md`: replace "This repo's project is named in its CLAUDE.md" with "find it with get_project (git remote, branch, path)" — waiting on Om's yes.

## Later
- Claude Code on this PC: `claude mcp add --scope user … work-os` with a key from Connect → Claude Code — waits on Om creating the key.
- Om's devices: add passkeys and turn on the authenticator app in Settings → Security — waits on Om.
- Per-session attribution header (`X-Work-OS-Session` from `CLAUDE_CODE_SESSION_ID`): check whether user-scope MCP config expands env vars — waits on the MCP being added.
- Discord interactions endpoint URL (slash commands) — waits on Om.
- cutroom has no Work OS project yet — create one when Om first works on it from Claude Code.
