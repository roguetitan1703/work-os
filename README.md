# Work OS

Personal task system: Today view, board, projects, per-task history, and an MCP endpoint so Claude (claude.ai chat and a morning brief) can read and update tasks.

Next.js 16 on Vercel, data in MongoDB Atlas.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in MONGODB_URI etc.
npm run dev
```

Open http://localhost:3000. With `APP_PASSWORD` unset, local dev skips the login screen.

## Data model

- **tasks**: title, description, project, mode, priority (P1–P4), status (Not Started / In Progress / Blocked / Done / Dropped), tags, start and due dates, estimate, progress %, checklist, links, blocked reason, dependencies, recurrence, archived. Each task has a short number (`#12`).
- **activity**: one entry per change (created, status, progress with note, edit diff, note, checklist, completed, reopened, archived), with who did it: `me` (the UI), `claude` (MCP) or `system`.
- **projects**: name, client, description, status.
- **reviews**, **ritualLogs**: weekly review and the Fiverr ritual check-in.

All reads and writes go through `lib/data/*`, which is shared by the UI (server actions), the JSON API and the MCP server. Nothing is ever hard-deleted: tasks are archived or set to Dropped.

## Auth

| Surface | How |
|---|---|
| Web UI | `/login` with `APP_PASSWORD` → signed, httpOnly cookie (`SESSION_SECRET`), checked in `proxy.ts` and again in every server action |
| `/api/mcp` | API key `MCP_TOKEN` in a header: `Authorization: Bearer <key>` or `X-API-Key: <key>`. (`/api/mcp/<key>` only if `MCP_ALLOW_URL_TOKEN=1`) |
| other `/api/*` | session cookie or `Authorization: Bearer <MCP_TOKEN>` |

In production, missing secrets fail closed.

## MCP tools

`list_tasks`, `get_task`, `add_task`, `update_task`, `log_progress`, `complete_task`, `add_note`, `update_checklist`, `list_projects`, `add_project`, `update_project`, `daily_summary`, `recent_activity`. No delete.

Connector for claude.ai (Settings → Connectors → Add custom connector; the app's `/connect` page has copy buttons):

- URL: `https://<your-app>.vercel.app/api/mcp`
- Authentication: no sign-in; Request headers: `Authorization: Bearer <MCP_TOKEN>`

Smoke test:

```bash
node scripts/test-mcp.mjs https://<your-app>.vercel.app/api/mcp <MCP_TOKEN>          # read-only
node scripts/test-mcp.mjs https://<your-app>.vercel.app/api/mcp <MCP_TOKEN> --write  # also creates, progresses, completes and drops a test task
```

## Notes

Notion-style pages (BlockNote editor: `/` menu, toggles, callouts, colours, tables, drag handles, `@` mentions of tasks and projects, sub-pages, images and files). A task has one note; projects can have many; sub-pages nest inside any note. Blocks are stored as the source of truth with a markdown copy for search and for Claude, who edits by block id (`read_note` → `write_note` with `block_ops`) so formatting it doesn't touch is kept. Saves carry the version they edited; if Claude changed the page meanwhile, the editor reloads instead of overwriting.

Images and files go to a **private** Vercel Blob store and are served only to a logged-in session via `/api/notes/file`. Setup: Vercel → Storage → Create → Blob (private) → connect to this project (adds `BLOB_READ_WRITE_TOKEN`) → redeploy.

## Alerts (Discord DMs)

The bot DMs Om when work slips: due tomorrow (18:00, P1/P2), due today (09:00), overdue (morning after, then every 2 days), stalled (In Progress, no activity for 2 workdays), P1 never started (24h), unblocked (as soon as the last dependency closes). Quiet hours 23:00–08:00 IST; one batched DM per check; each alert sent once (`alertLog`). `/api/cron/alerts` is called every 15 minutes by cron-job.org with `Authorization: Bearer <CRON_SECRET>`; `?dry=1` previews. Unblocked alerts are queued inside the closing write's transaction and also flushed right after MCP, Discord and app writes. Status and setup are on `/connect`.

## Discord (server "Delpat")

No hosted bot, no gateway, nothing stored. Claude reads Discord on demand through MCP tools that call Discord's REST API with the bot token; commands arrive on `/api/discord/interactions` (signature-verified) and only the owner can use them. The bot never posts; its only output is ephemeral replies.

MCP tools (read-only, plus one write into Work OS):

- `discord_needs_attention`: flagged-for-later items (your messages that tag the bot, with what you replied to), mentions of you/your roles/@everyone, replies to you, new activity in your threads; each marked handled if you posted after. Only channels active since the cutoff are read.
- `discord_list_channels`: channels + active threads with last activity, filterable; unreadable ones listed separately.
- `discord_read_messages`: messages from a channel/thread by time or around/before/after a message.
- `discord_message_to_task`: create a task from a message (deduped by message id).

Commands: right-click a message → Apps → **Add to Work OS**, `/task`, `/today`, `/done`, `/progress` (writes show in history as "You · Discord").

Setup, invite URL, env vars and live status are on the app's `/connect` page. Env: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_ID`. Register commands (guild-scoped) with:

```bash
curl -X POST https://<your-app>.vercel.app/api/admin/discord/register -H "Authorization: Bearer <MCP_TOKEN>"
```

## Migrating the old `data/tasks.json`

The deployed app does the import itself, so no database credentials are needed locally:

```bash
curl -H "Authorization: Bearer <MCP_TOKEN>" https://<your-app>.vercel.app/api/admin/health   # connects, creates indexes, shows counts
node scripts/migrate-from-json.mjs https://<your-app>.vercel.app <MCP_TOKEN> --dry-run
node scripts/migrate-from-json.mjs https://<your-app>.vercel.app <MCP_TOKEN>
```

Safe to re-run: tasks already in the DB are never overwritten and refs are kept. It verifies every task, review and ritual log against the source afterwards.

## Quick capture

Press `N` anywhere (or use the bar on Today, Board and project pages):

```
Send invoice @"Grant Leads" !1 #billing due:fri ~20m mode:admin
```

`@project`, `!1`–`!4`, `#tag`, `due:` / `start:` (today, tomorrow, fri, +3d, 2026-10-20), `~45m` / `~1h30m`, `mode:code|client|team|sales|growth|research|founder|admin`. Shift+Enter opens the full form.
