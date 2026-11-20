# Work OS

**Full handover (features, options, code map): [docs/HANDOVER.md](docs/HANDOVER.md)**

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

## Phone app (PWA)

Under 768px the app switches to a phone UI (desktop is unchanged): bottom tabs (Today, Tasks, +, Notes, More), a Today screen of overdue / due today / in progress / blocked / up next with tap-to-complete and undo, a searchable Tasks list with segments and project chips, a quick-add bottom sheet with one-tap due/priority/project, and a full-screen task view with one-tap status and priority, native date/project pickers, checklist, note, comments and a sticky Mark done. Installable: web manifest (`app/manifest.ts`), generated icons (`/icons/*`), service worker (`public/sw.js`, network-first pages, offline fallback), safe-area aware. Install: iPhone Safari → Share → Add to Home Screen; Android Chrome → Install app.

## Notes

Notion-style pages (BlockNote editor: `/` menu, toggles, callouts, colours, tables, drag handles, `@` mentions of tasks and projects, sub-pages, images and files). A task has one note; projects can have many; sub-pages nest inside any note. Blocks are stored as the source of truth with a markdown copy for search and for Claude, who edits by block id (`read_note` → `write_note` with `block_ops`) so formatting it doesn't touch is kept. Saves carry the version they edited; if Claude changed the page meanwhile, the editor reloads instead of overwriting.

Images and files go to a **private** Vercel Blob store and are served only to a logged-in session via `/api/notes/file`. Setup: Vercel → Storage → Create → Blob (private) → connect to this project (adds `BLOB_READ_WRITE_TOKEN`) → redeploy.

## Alerts (Discord DMs)

The bot DMs Om when work slips: due tomorrow (18:00, P1/P2), due today (09:00), overdue (morning after, then every 2 days), stalled (In Progress, no activity for 2 workdays), P1 never started (24h), unblocked (as soon as the last dependency closes). Quiet hours 23:00–08:00 IST; one batched DM per check; each alert sent once (`alertLog`). `/api/cron/alerts` is called every 15 minutes by cron-job.org with `Authorization: Bearer <CRON_SECRET>`; `?dry=1` previews. Unblocked alerts are queued inside the closing write's transaction and also flushed right after MCP, Discord and app writes. Status and setup are on `/connect`.

## Discord (server "Delpat")

A small listener (`deploy/discord-gateway.mjs`, the `work-os-discord` unit) hears the server live and hands each event to the app (`/api/discord/gateway`). Work OS has no slash commands and no message commands. People connect their Discord account in Settings › Notifications (Connect Discord, Discord's own sign-in, scope `identify`); the bot works from posts in a project's bug channel, the track emoji, and the buttons on its reply (Undo, Done, For). Its replies mention nobody.

MCP tools (they read what the person's own Discord account can see; the only writes are one short reply under a message a task came from, and tasks):

- `discord_needs_attention`: flagged-for-later items (your messages that tag the bot, with what you replied to), mentions of you/your roles/@everyone, replies to you, new activity in your threads; each marked handled if you posted after. Only channels active since the cutoff are read.
- `discord_list_channels`: channels + active threads with last activity, filterable; unreadable ones listed separately.
- `discord_read_messages`: messages from a channel/thread by time or around/before/after a message, as compact rows (`links: true` gives jump links).
- `discord_attachment`: one screenshot or PDF of a message (10 MB at most), as base64.
- `discord_reply`: one line (140 characters) under the message a task came from; the first line on a bug-channel task replaces the bot's Recorded reply.

Setup, invite URL, env vars and live status are in Settings › Notifications. Env: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET` (Connect Discord). The OAuth redirect URL to add in the Developer Portal is `<APP_URL>/api/discord/connect/callback`. Details: docs/HANDOVER.md section 6 and docs/hosting.md.

## Health check

```bash
curl -H "Authorization: Bearer <MCP_TOKEN>" https://<your-app>.vercel.app/api/admin/health   # connects, creates indexes, shows counts
```

## Quick capture

Press `N` anywhere (or use the bar on Today, Board and project pages):

```
Send invoice @"Grant Leads" !1 #billing due:fri ~20m mode:admin
```

`@project`, `!1`–`!4`, `#tag`, `due:` / `start:` (today, tomorrow, fri, +3d, 2026-10-20), `~45m` / `~1h30m`, `mode:code|client|team|sales|growth|research|founder|admin`. Shift+Enter opens the full form.
