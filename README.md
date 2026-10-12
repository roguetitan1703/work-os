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
| `/api/mcp` | `MCP_TOKEN`, either `Authorization: Bearer <token>` or as a path segment: `/api/mcp/<token>` |
| other `/api/*` | session cookie or `Authorization: Bearer <MCP_TOKEN>` |

In production, missing secrets fail closed.

## MCP tools

`list_tasks`, `get_task`, `add_task`, `update_task`, `log_progress`, `complete_task`, `add_note`, `update_checklist`, `list_projects`, `add_project`, `update_project`, `daily_summary`, `recent_activity`. No delete.

Connector URL for claude.ai (Settings → Connectors → Add custom connector):

```
https://<your-app>.vercel.app/api/mcp/<MCP_TOKEN>
```

Smoke test:

```bash
node scripts/test-mcp.mjs https://<your-app>.vercel.app/api/mcp/<MCP_TOKEN>          # read-only
node scripts/test-mcp.mjs https://<your-app>.vercel.app/api/mcp/<MCP_TOKEN> --write  # also creates, progresses, completes and drops a test task
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
