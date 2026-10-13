# Work OS: handover

Work OS is Om's task system: tasks, projects, Notion-style notes, Discord and alerts, used from a laptop, a phone and by Claude.

- Live app: https://work-os-puce-delta.vercel.app
- Code: https://github.com/roguetitan1703/work-os (public; no secrets in it)
- Hosting: Vercel (Node 22). Database: MongoDB Atlas. Pushing to `master` deploys.

Each section below covers one feature in three parts: **Om** (what you can do in the app or on Discord), **Claude** (what Claude on claude.ai can do through the connector) and **Claude Code** (where the code lives and what to watch out for when changing it).

---

## Contents

1. [Setup and environment](#1-setup-and-environment)
2. [Tasks and projects](#2-tasks-and-projects)
3. [Claude connector (MCP)](#3-claude-connector-mcp)
4. [Batch changes, full project view, trash](#4-batch-changes-full-project-view-trash)
5. [Notes (Notion-style pages)](#5-notes-notion-style-pages)
6. [Discord: reading, commands, blocked channels](#6-discord)
7. [Alerts (Discord DMs)](#7-alerts-discord-dms)
8. [Phone app (PWA)](#8-phone-app-pwa)
9. [Login and security](#9-login-and-security)
10. [Still to do / known limits](#10-still-to-do--known-limits)
11. [Working on the code (Claude Code)](#11-working-on-the-code-claude-code)

---

## 1. Setup and environment

All configuration is in Vercel → Project → Settings → Environment Variables. For local development, copy the same variables into `work-os/.env.local`, which is gitignored. `.env.example` lists every variable.

| Variable | What it is | Required |
|---|---|---|
| `MONGO_MONGODB_URI` (or `MONGODB_URI`) | Atlas connection string; the Vercel Atlas integration adds the `MONGO_` prefix and both names work | yes |
| `MONGODB_DB` | database name (`workos`) | default `workos` |
| `APP_PASSWORD` | password for the web app | yes |
| `SESSION_SECRET` | signs the login cookie (long random string) | yes |
| `MCP_TOKEN` | API key for Claude's connector and the admin endpoints | yes |
| `APP_TZ`, `NEXT_PUBLIC_APP_TZ` | `Asia/Kolkata`: sets what "today" means | yes |
| `APP_URL` | public base URL, used in links sent to Claude and Discord | recommended |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_ID` | Discord bot and the Delpat server | for Discord |
| `DISCORD_BLOCKED_CHANNELS` | extra channel ids never to read (comma-separated); normally managed on `/connect` instead | optional |
| `CRON_SECRET` | protects the alert check endpoint | for alerts |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private) for images and files in notes | not used yet |
| `MCP_ALLOW_URL_TOKEN` | `1` allows putting the key in the URL (`/api/mcp/<key>`) instead of a header | leave unset |

**Health check:** `GET /api/admin/health` with `Authorization: Bearer <MCP_TOKEN>` returns database status, document counts, the Node version, and whether the note converter works.

---

## 2. Tasks and projects

### What a task has
A number (`#12`), title, description, project, mode (type of work), priority P1–P4, status (Not Started, In Progress, Blocked, Done, Dropped), tags, start and due dates, estimate, progress %, checklist, links, blocked reason, dependencies ("waits on #5"), a repeat schedule (daily, weekdays, weekly or monthly; the next one is created when it's completed) and archived. Every change is written to the task's **history**, which records who made it: **You**, **You · Discord**, **Claude** or **System**.

### Om
- **Laptop:**
  - **Today:** schedule, current time block, overdue, in progress, blocked, rituals.
  - **Board:** columns by status, with filters.
  - **Projects:** progress per client.
  - **Task page:** edit everything inline, log progress, checklist, comments, history.
  - **History:** Completed, Activity (filter by you, Discord or Claude), Archived, Trash.
- **Quick add:** press **N** anywhere. You can type it all in one line:
  - `Send invoice @"Grant Leads" !1 #billing due:fri ~20m mode:admin`
  - That reads as: `@project`, `!1`–`!4` for priority, `#tag`, `due:`, `start:`, `~20m` for the estimate, `mode:`.
- **Completing a recurring task** creates its next occurrence automatically.
- **Reopening a done task** restores its earlier progress. It no longer stays at 100%.

### Claude
`list_tasks`, `get_task`, `add_task`, `update_task`, `log_progress`, `complete_task`, `add_comment`, `update_checklist`, `list_projects`, `add_project`, `update_project`, `daily_summary`, `recent_activity`.
- **`daily_summary`** is the one call for a morning brief: overdue, due today, in progress, blocked and waiting, the next 7 days, everything completed or changed since the last workday and who did it, and per-project counts.
- **Dates** accept `today`, `tomorrow`, weekday names, `+3d`, `+2w` or `YYYY-MM-DD`.

### Claude Code
- **Data layer:** `lib/data/tasks.ts` (create, update, history, recurrence, queries) and `lib/data/projects.ts`. Pages, server actions (`app/actions.ts`), MCP and Discord all go through it.
- **Types:** `lib/types.ts` (zod schemas). Stored document shapes and indexes: `lib/db.ts`.
- **History:** entries in `activity` are written by `logActivity()`; display text comes from `lib/activity-text.ts`.

---

## 3. Claude connector (MCP)

### Om
- **Connecting:** claude.ai → Settings → Connectors → Add custom connector:
  - URL: `https://work-os-puce-delta.vercel.app/api/mcp`
  - Authentication: no sign-in. Request header: `Authorization: Bearer <MCP_TOKEN>`.
- **The `/connect` page** ("Connect Claude" in the sidebar, or More → Settings on the phone) has:
  - the URL and header with copy buttons (the key is hidden until you click reveal)
  - instructions to paste into a Claude Project or your preferences
  - a **morning brief** prompt covering Work OS and Discord
  - every tool with a description and an example question
  - Discord setup with live status
  - alert status
- **To change the key:** update `MCP_TOKEN` in Vercel, redeploy, then update the header in claude.ai.

### Claude
- **Every write is attributed to Claude** in history.
- **The connector tells Claude how to behave:**
  - Refer to tasks as `#12`.
  - Add a short note to writes.
  - Use `log_progress` and `complete_task`.
  - Use `apply_changes` for multi-step work and `get_project` for overviews.
  - Update an existing note before creating a new one.

### Claude Code
- **Endpoint:** `app/api/mcp/[[...key]]/route.ts`. Stateless Streamable HTTP. The key goes in a header (`Authorization: Bearer` or `X-API-Key`).
- **Tool handlers:** `lib/mcp/server.ts`.
- **Tool titles, descriptions and server instructions:** `lib/mcp/docs.ts`. This one file feeds both MCP and the `/connect` page, so edit descriptions there.
- **Adding a tool:** add its name to `ToolName` and an entry in `TOOLS` (docs.ts), register it with `tool(...)` in server.ts, and add it to `ORDER` in `app/(app)/connect/page.tsx`.
- **Smoke test:** `node scripts/test-mcp.mjs <url>/api/mcp <MCP_TOKEN> [--write]`.

---

## 4. Batch changes, full project view, trash

### Om
- **Delete a task:** task page → Delete; on the phone, task → ⋯ → Delete. It goes to the **trash for 30 days**, together with its history and note, and the confirmation has **Undo**.
- **Trash:** History → **Trash** (on the phone, More → Trash) lets you Restore or Delete forever. Opening a deleted task's link shows "This task is in the trash" with a Restore button.
- **Comments:** hover a comment in a task's history to Edit or Delete it. You can do this on any comment.

### Claude
- **`apply_changes`:** up to 100 changes in **one atomic call**; if any change fails, nothing is saved.
  - **Operations:** `create_task`, `update_task`, `log_progress`, `complete_task`, `add_comment`, `edit_comment`, `delete_comment`, `update_checklist`, `archive_task`, `delete_task`, `restore_task`, `write_note`, `delete_note`, `add_project`, `update_project`.
  - **Names for new tasks:** a `create_task` can set `as: "$spec"`, and later operations can use `"$spec"` as the task, including in `depends_on`.
  - **`dry_run: true`** runs everything and then rolls it back, showing what would happen.
- **`get_project`** (depth `project`, `tasks` or `full`) returns one project in a single call:
  - stats, project notes and recent activity
  - its tasks with their notes
  - checklists, what each waits on, and history entries with their ids
- **`delete_task`** requires the task's **title** as a check, so a typo in the number can't delete the wrong task. It moves the task to the trash.
- **`restore_task`, `list_trash`:** bring a task back, and list what's in the trash.
- **Comments:** Claude can edit or delete **only its own** comments. Its other history entries can have their note text edited but not be deleted.
- **Already done:** #80–#94 (added by mistake) are in the trash, and a stale comment on #76 was removed.

### Claude Code
- **Batch engine:** `lib/data/batch.ts`.
- **Transactions:** `inTransaction()` in `lib/db.ts`. An AsyncLocalStorage proxy attaches the transaction's session to every collection call, so data functions need no changes. `dryRun` aborts the transaction at the end.
  - Inside a transaction, avoid relying on duplicate-key errors: they abort the whole transaction (see `insertProject`).
  - Transactions need a replica set. Atlas is one; a local mongod needs `--replSet rs0`.
- **Trash:** a separate `trash` collection holding the whole task plus its history (`trashTask` / `restoreTask` / `purgeTrash` in tasks.ts), so no query needs a "not deleted" filter. Items older than 30 days are purged whenever the trash is listed.
- **Project tree:** `lib/data/tree.ts`.
- **App side:** `components/trash-controls.tsx`, `components/comment-entry.tsx`, and the Trash tab in `app/(app)/history/page.tsx`.

---

## 5. Notes (Notion-style pages)

### Om
- **Editor:** a Notion-style page.
  - **`/` menu:** headings, to-dos, bullets and numbers, toggles, quotes, callouts, code, tables, dividers, emoji.
  - **Formatting:** colours, bold, italic and so on from the selection toolbar.
  - **Drag handles** to reorder blocks.
- **Linking:**
  - **`@`** mentions a task or project inline; tapping it opens it.
  - **`/` → Sub-page** creates a page inside the note. Its title shows in the parent as a link, and breadcrumbs lead back.
- **Where notes live:**
  - **A task has one note:** "Add a note" or "Open note" on the task.
  - **Projects can have many:** the Notes section on the project page.
  - **All notes:** the **Notes** page (sidebar, or the phone tab). It's one flat list, newest first, filtered by project, active / archived / all, task or project notes, plus a text search.
- **Archiving:**
  - A task's note is archived automatically when the task is done or dropped, and stays readable.
  - A project note can be archived by hand.
- **Saving:** automatic, about 1 second after you stop typing, or Ctrl+S.
- **Delete:** a page goes to the trash for 30 days, with Undo. Deleting a page also deletes its sub-pages.
- **If Claude edits a page while you have it open,** your old copy won't overwrite Claude's changes. You get a warning and the page reloads. Anything typed in those few seconds is lost, so copy it first if it matters.
- **Images, video, audio and files are switched off for now.** They're hidden from the `/` menu, and pasting files does nothing.

### Claude
- **`list_notes`:** id, title, first line, what it's attached to, last edited. Filters: project, state, kind, search.
- **`read_note`:** the markdown, plus **blocks** (`id`, `type`, `markdown` each) and sub-pages.
- **`write_note`:**
  - **Which note:** by `note_id`, or by `task` (that task's one note, created if missing). A **new** project note needs `project` and `title`. A new sub-page needs `parent_id` and `title`.
  - **How the content changes**, one of:
    - **`block_ops`** (preferred): replace, insert or delete by block id. Everything else keeps its formatting.
    - **`edits`** `[{find, replace}]`: the text must occur exactly once; only that block is rewritten.
    - **`append`**: markdown added at the end.
    - **`body`**: replaces the whole page and drops Notion-only formatting.
  - **Links:** `[#12 Title](/tasks/12)` and `[Name](/projects/<id>)` become mentions.
- **`delete_note`** needs the title as a check.
- **No duplicate notes:** `get_task`, `get_project` and `list_projects` include each note's id, title and first line, so Claude can see what exists and update it instead of creating another.

### Claude Code
- **Editor:** BlockNote 0.55 (`@blocknote/react`, `@blocknote/mantine`). Schema: `lib/notes-schema.ts`, with custom `mention` inline content and a `page` block. Plain DOM renderers, so it works in the browser and on the server.
- **Storage:** blocks are the source of truth (`notes.blocks`). `body` is markdown derived from them, used for search, previews and Claude. Old markdown-only notes convert when loaded.
- **Converter:** `lib/notes-convert.ts` (server-side markdown ↔ blocks, per-block outline, block surgery). It is loaded **lazily**, because if it fails to load it must not take down other routes. An earlier version did take MCP down.
  - **Needs jsdom 26:** an npm override in package.json pins it. jsdom 29 uses ES-module `require()`, which Vercel doesn't support.
  - **Needs `serverExternalPackages`** for BlockNote in `next.config.ts`.
- **Data:** `lib/data/notes.ts`.
  - **One live note per task:** a partial unique index on `{taskId, deletedAt}`.
  - **Soft delete:** `deletedAt`; deletion cascades to sub-pages.
  - **Version check:** `expectUpdatedAt` raises `NoteConflictError`.
  - **Task trash:** the note goes to the trash and comes back with its task.
- **UI:**
  - `app/(app)/notes/` (list, `[id]` page, `block-editor.tsx`, `note-editor.tsx`, `actions.ts`)
  - `components/new-note-button.tsx`
  - styles under "Notes editor" in `app/globals.css`
- **Turning uploads back on:**
  1. Create a **private** Vercel Blob store and connect it to the project (this adds `BLOB_READ_WRITE_TOKEN`).
  2. Set `UPLOADS_ENABLED = true` in `block-editor.tsx`.
  3. Nothing else is needed: the routes `app/api/notes/upload` and `app/api/notes/file` already exist. Files are served only to a logged-in session.

---

## 6. Discord

There's no bot server running all the time and no messages are stored.
- **Reading:** when Claude asks, Work OS calls Discord directly at that moment, using the bot's token.
- **Commands:** they arrive at `/api/discord/interactions`, which checks Discord's signature on every request.
- **Posting:** the bot never posts in channels, reacts or changes anything. Its only output is replies that only Om can see, plus DMs to Om (see section 7).

### Om
- **Right-click a message → Apps → Add to Work OS:**
  - Creates a task with a short title drafted from the message, the quoted message, author, channel and a jump link.
  - Project and mode are guessed from the channel name; priority is P2; a due date is set only if the message clearly states one.
  - The reply has a priority dropdown, Due today / Due tomorrow / No due date buttons, and Edit title.
  - If that message is already a task, it says "Already tracked as #ref" instead.
- **Slash commands** (replies only you can see):
  - `/task title [priority] [due] [project] [mode]`: project names autocomplete.
  - `/today`: overdue, due today, in progress and open P1s.
  - `/done ref [note]`
  - `/progress ref percent [note]`: the task number autocompletes from open tasks.
- **Tag the bot in any message:** nothing happens on Discord. Claude lists it as **"flagged for later"**, with the message you were replying to.
- **Who can use them:** only your Discord user ID. Anyone else gets "Not available".
- **Sensitive channels:** `/connect` → Discord → "Sensitive channels: never read". Tick channels or whole categories, then Save. They're never listed or scanned, and links or right-clicks into them are refused.
  - For a hard guarantee, also deny the bot's role **View Channel** in those channels in Discord.

### Claude
- **`discord_needs_attention`:** one call for "what needs me on Discord", since the start of the last workday (Asia/Kolkata) by default. It lists:
  - flagged-for-later items
  - mentions of Om or his roles, @everyone and @here, and replies to Om
  - new activity in threads Om is in
  - each marked **handled** if Om posted after it
  - warnings: Message Content Intent off, channels the bot can't read, scan capped
- **`discord_list_channels`:** channels and active threads with when each last had activity. Can filter to "active since".
- **`discord_read_messages`:** by channel name, id or link, either since a time or before/after/around a message. For each message:
  - author, and whether it's Om
  - time and text
  - mentions, and the message it replies to
  - attachment names
  - thread info and a jump link
- **`discord_message_to_task`:** creates a task from a message, attributed to Claude. If the message is already a task, it returns that task instead of creating a duplicate.
- **Out of reach:** personal DMs and group DMs. Bots can't see them.

### Claude Code
- **REST client:** `lib/discord/client.ts`.
  - Rate-limit retries, at most 4 requests at once, time budgets.
  - The channel list and roles are cached for 90 seconds.
  - Permission checks per channel, and the blocklist (`assertNotBlocked`).
  - Message ids encode a timestamp, which is how "active since" works.
- **Reads:** `lib/discord/read.ts`. Message → task: `lib/discord/to-task.ts`.
- **Commands:** `lib/discord/commands.ts`.
- **Interactions endpoint:** `app/api/discord/interactions/route.ts`. Ed25519 signature check, owner and server check, immediate deferred reply, the work runs in `after()`.
- **Registering commands:** `POST /api/admin/discord/register` with the `MCP_TOKEN` header, scoped to the Delpat server. Re-run it whenever commands change.
- **Blocklist storage:** `settings` collection, document `_id: 'discord'`.
- **Testing:** set `DISCORD_API_BASE` to point at a fake Discord.

---

## 7. Alerts (Discord DMs)

### Om
| Alert | When |
|---|---|
| Due tomorrow | 18:00 the day before, P1 and P2 |
| Due today | 09:00, all tasks due that day |
| Overdue | The morning after the due date, then every 2 days |
| Stalled | In Progress with no activity for 2 workdays |
| Never started | P1 still Not Started 24 hours after creation |
| Unblocked | Right away, when the last task it waited on is closed |

- **Rules:** quiet hours 23:00–08:00 IST (anything due then waits until morning), one combined DM per check, and each alert sent only once.
- **Status:** `/connect` → Alerts shows when the last check ran and what it did.
- **Setup still to do:**
  1. Add `CRON_SECRET` in Vercel; the value is in `work-os/.env.local`.
  2. On cron-job.org, create a job every 15 minutes on `https://work-os-puce-delta.vercel.app/api/cron/alerts` with the header `Authorization: Bearer <CRON_SECRET>`.
  3. If DMs fail with a 403: Discord → Delpat server → Privacy Settings → allow direct messages.

### Claude
Nothing to call; alerts run on their own. Claude's own changes trigger them like anyone's: when Claude completes a blocking task, the unblocked alert goes out.

### Claude Code
- **Logic:** `lib/alerts.ts`. The thresholds are in `ALERT_RULES`.
  - `alertLog`: one record per alert sent, so each goes out once.
  - `alertQueue`: unblocked alerts waiting to be sent.
- **Queueing:** `queueUnblocked()` is called from `updateTask` **inside** the same transaction as the write, so a batch that rolls back never queues an alert.
- **Sending soon after a write:** `flushQueuedAlerts()` runs via `after()` in the MCP route, the Discord interactions route and the app's server actions.
- **Endpoint:** `app/api/cron/alerts/route.ts`. Without the `CRON_SECRET` header it returns 401 (503 if the secret isn't set at all).
  - `?dry=1` previews without sending.
  - `?at=<ISO>` simulates a different time; it is ignored in production.
- **Discord:** DMs are sent by the same bot, which opens a DM channel with the owner.

---

## 8. Phone app (PWA)

### Om
- **Install:** iPhone: Safari → Share → **Add to Home Screen**. Android: Chrome → **Install app**. Long-press the icon for the **New task** and **Notes** shortcuts. On iPhone, sign in once inside the installed app.
- **Below 768px wide, the app uses the phone interface;** the laptop view doesn't change.
  - **Tab bar:** Today, Tasks, **+**, Notes, More.
  - **Today:**
    - Counts at the top (overdue, due today, in progress) that jump to their section.
    - Cards for Overdue, Due today, In progress, Blocked/waiting, Up next.
    - Tap a circle to complete a task, with **Undo**.
  - **+ (quick add):**
    - A big text field.
    - One-tap chips for due date (Today, Tomorrow, Friday, Next week), priority and project.
    - "Add task", or "Add & open" to go straight to it.
  - **Tasks:** search, Open / Due soon / Waiting / Done tabs, project chips, and open tasks grouped by priority.
  - **Task screen:**
    - One-tap status and priority.
    - Due chips plus the phone's own date picker.
    - Progress, and the phone's own pickers for project and mode.
    - Note card, checklist, description, linked tasks, comments, history.
    - A sticky **Mark done** button. The ⋯ menu has Drop, Reopen, Archive and Delete.
  - **Notes:** the same editor, sized for the phone.
  - **More:** projects with open and late counts, plus History, Hidden work, Weekly review, Timetable, Recovery, Trash, Connect, Appearance, Sign out.
- **Offline:** shows a "You're offline" screen.

### Claude Code
- **Phone components:** `components/mobile/`
  - `tab-bar.tsx`: tab bar and `MobileHeader`
  - `quick-add-sheet.tsx`
  - `m-today.tsx`, `m-tasks.tsx`, `m-task-row.tsx`, `m-task-detail.tsx`
- **How pages switch:** a page renders the phone view inside `md:hidden` and the desktop view inside `hidden md:block`. See `today/page.tsx`, `board/page.tsx` and `tasks/[id]/page.tsx`.
- **More tab:** `app/(app)/more/page.tsx`.
- **PWA files:**
  - manifest: `app/manifest.ts`
  - icons: `app/icons/[size]/route.tsx`
  - service worker: `public/sw.js` (pages fetched fresh first, built files cached, offline fallback `public/offline.html`); registered by `components/pwa.tsx`, production only
  - viewport and theme colour: `app/layout.tsx`
- **Login exclusions:** these files must load without a login, so they're listed in `proxy.ts`'s matcher.
- **Phone touches:**
  - Toasts appear at the top on phones (`components/ui/sonner.tsx`).
  - Text fields use 16px type to prevent iOS zoom.
  - The desktop time-block tint is hidden on phones.

---

## 9. Login and security

- **Web app:** password login with a signed 60-day cookie. `proxy.ts` protects every page and API.
- **Routes that check their own credentials instead:**
  - `/api/mcp`: `MCP_TOKEN` header
  - `/api/discord/interactions`: Discord signature
  - `/api/cron/alerts`: `CRON_SECRET`
  - the PWA files: public
- **Admin endpoints** (`/api/admin/*`) accept the `MCP_TOKEN` header.
- **The repo is public.** Secrets live only in Vercel and in the gitignored `.env.local`. Before each push, a scan checks that no secret is being committed.
- **Discord:** only Om's user ID, only in the Delpat server, sensitive channels blocked. The bot's permissions are View Channels and Read Message History only.

---

## 10. Still to do / known limits

**For Om:**
1. **PC:** move the Windows pagefile from C: to D: and restart. C: keeps filling up because of it.
2. **Alerts:** add `CRON_SECRET` in Vercel and create the cron-job.org job (section 7).
3. **Discord:**
   - Tick sensitive channels on `/connect`.
   - Change the dev@ and tools@ passwords, which were posted in #our-own-system-automation.
   - If `/today` says "did not respond", set the Interactions Endpoint URL in the Discord Developer Portal to `https://work-os-puce-delta.vercel.app/api/discord/interactions`.
4. **Claude:** paste the updated morning-brief prompt from `/connect` into the 8am brief.
5. **Phone:** install it and report anything that feels off. It was tested in an emulated iPhone, not on a real device.

**Known limits:**
- **Simultaneous edits:** if Claude edits a note you have open, your last few seconds of typing are lost when the page reloads (you're warned first).
- **Pre-existing lint errors** in `today-client.tsx`, `current-block-bar.tsx` and `api/timetable/today` are untouched.
- **Images and files** in notes are off until Blob storage is set up.

---

## 11. Working on the code (Claude Code)

- **Read first:** `AGENTS.md`. This Next.js (16.2) has breaking changes; docs are in `node_modules/next/dist/docs/`.
- **Checks before pushing:**
  - `npx tsc --noEmit -p .`
  - `npx eslint <touched files>`
  - `npx next build`
- **Pushing to `master` deploys.** Then check:
  - `/api/admin/health`, which should report `notesConverter: "ok"`
  - `node scripts/test-mcp.mjs …`
- **Commits:** no co-author or "Generated with" lines (Om's preference).
- **Testing locally:**
  - **MongoDB:** transactions need a replica set: `mongod --replSet rs0 --port 28020 --dbpath <dir>`, then `replSetInitiate`. Load data with `node scripts/migrate-from-json.mjs http://localhost:<port> <MCP_TOKEN>`.
  - **Discord:** set `DISCORD_API_BASE` to a fake Discord.
  - **Alerts:** `/api/cron/alerts?dry=1&at=<ISO>` works outside production.
  - **Phone:** Playwright with a 390×844 touch viewport.
  - **Keep scratch files out of the repo.** Earlier test scripts lived in `work mode os/.scratch-mongo/`.
- **Where to change common things:**
  - Alert rules: `ALERT_RULES` in `lib/alerts.ts`
  - Tool wording: `lib/mcp/docs.ts`
  - Quick-add syntax: `lib/quick-parse.ts`
  - Modes and colours: `lib/modes.ts`
  - Timezone: `APP_TZ`
