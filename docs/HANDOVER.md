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
7. [Alerts and notifications](#7-alerts-and-notifications)
8. [Phone app (PWA)](#8-phone-app-pwa)
9. [Settings](#9-settings)
10. [Login and security](#10-login-and-security)
11. [Still to do / known limits](#11-still-to-do--known-limits)
12. [Working on the code (Claude Code)](#12-working-on-the-code-claude-code)

---

## 1. Setup and environment

All configuration is in Vercel → Project → Settings → Environment Variables. For local development, copy the same variables into `work-os/.env.local`, which is gitignored. `.env.example` lists every variable.

| Variable | What it is | Required |
|---|---|---|
| `MONGO_MONGODB_URI` (or `MONGODB_URI`) | Atlas connection string; the Vercel Atlas integration adds the `MONGO_` prefix and both names work | yes |
| `MONGODB_DB` | database name (`workos`) | default `workos` |
| `APP_PASSWORD` | password for the web app until it is reset or changed (then the stored hash is used instead; section 10) | yes |
| `SESSION_SECRET` | signs the login cookie (long random string) | yes |
| `MCP_TOKEN` | API key for Claude's connector and the admin endpoints | yes |
| `APP_TZ`, `NEXT_PUBLIC_APP_TZ` | `Asia/Kolkata`: sets what "today" means | yes |
| `APP_URL` | public base URL, used in links sent to Claude and Discord | recommended |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_ID` | Discord bot and the Delpat server | for Discord |
| `DISCORD_BLOCKED_CHANNELS` | extra channel ids never to read (comma-separated); normally managed on `/connect` instead | optional |
| `CRON_SECRET` | protects the alert check endpoint | for alerts |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | keys for phone push (a `mailto:` address for the subject). **Must be added on Vercel**; copy the values from `.env.local`. Without them push is off and Settings → Status says so | for phone push |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | SMTP for "Forgot password?" links, password-change emails and the Settings test email. `EMAIL_SECURE=true` = TLS from the start (port 465); otherwise STARTTLS is required. **Must be added on Vercel**; copy the values from `.env.local` | for password reset |
| `OWNER_EMAIL` | the only address reset links are sent to; defaults to `EMAIL_FROM`. **Add on Vercel** | optional |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private) for images and files in notes | not used yet |
| `MCP_ALLOW_URL_TOKEN` | `1` allows putting the key in the URL (`/api/mcp/<key>`) instead of a header | leave unset |

**Health check:** `GET /api/admin/health` with `Authorization: Bearer <MCP_TOKEN>` returns database status, document counts, the Node version, and whether the note converter works.

---

## 2. Tasks and projects

### What a task has
A number (`#12`), title, description, project, mode (type of work), priority P1–P4, status (Not Started, In Progress, Blocked, Done, Dropped), tags, start and due dates, estimate, progress %, checklist, links, blocked reason, dependencies ("waits on #5"), a repeat schedule (daily, weekdays, weekly or monthly; the next one is created when it's completed) and archived. Every change is written to the task's **history**, which records who made it: **You**, **You · Discord**, **Claude**, **Claude Code** or **System**.

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

### Claude Code keys
- **Om:** `/connect` → **Claude Code keys**: name a key, **Create**, copy it (shown once) or the ready `claude mcp add --transport http work-os <url> --header "Authorization: Bearer <key>"` command. The list shows prefix, created and last used; **Rotate** (old key dies, new one shown) and **Revoke**. Changes made with a key show as **Claude Code** in history (filter "By Claude Code"), with the `X-Work-OS-Repo` / `X-Work-OS-Session` headers shown small next to them if the session sends them.
- **What a key can do:** everything the claude.ai connector can (projects, tasks, notes, trash, Discord reads; the channel blocklist still applies). **Only `/api/mcp` accepts keys**: `proxy.ts`, admin, import, cron and Discord registration use `checkToken()` (MCP_TOKEN only).
- **Rules** (`lib/mcp/policy.ts`, a no-op for MCP_TOKEN): no permanent deletion/admin tools or ops; 300 tool calls per rolling hour per key; 10 trashes per 10 minutes; an `apply_changes` that trashes > 10 items or changes > 50 tasks needs a dry run first, whose `confirm` token (HMAC of the ops + 10-minute expiry, `SESSION_SECRET`) the real call must pass. When a key changes title/priority/due/project of, or trashes, a task it didn't create, Om gets one inbox notice per call (Settings → Notifications → "Claude Code changes", default on).
- **Code:** `lib/api-keys.ts` (`wos_` + 32 random bytes base64url; only the SHA-256 is stored in `apiKeys`; `lastUsedAt` at most once a minute), `lib/mcp/policy.ts` (counters in `policyEvents`, TTL 2h), `lib/request-context.ts` (session/repo headers → `logActivity`), UI `app/(app)/connect/claude-code-keys.tsx` + `actions.ts`. No new env vars.
- **Project code locations:** projects have `code: [{remote, subdir?, branch?} | {path}]` (project page → Code locations, or `add_project` / `update_project` / batch ops). Remotes are stored as lowercase `owner/name`, credentials stripped. `get_project` with `remote`/`subdir`/`branch`/`path` instead of a name picks the most specific match (remote+subdir+branch > remote+subdir or +branch > remote > longest path), else returns `unmatched` with candidates. A branch ending in `*` matches by prefix (`wt/ana*`). Matcher: `lib/data/code-locations.ts` (pure functions).

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

## 7. Alerts and notifications

### Om
| Alert | When |
|---|---|
| Due tomorrow | 18:00 the day before, P1 and P2 |
| Due today | 09:00, all tasks due that day |
| Overdue | The morning after the due date, then every 2 days |
| Stalled | In Progress with no activity for 2 workdays |
| Never started | P1 still Not Started 24 hours after creation |
| Unblocked | Right away, when the last task it waited on is closed |

- **Where an alert goes:** three channels. Each alert type and each channel has a switch in Settings (section 9).
  - **In-app inbox:** always on. Bell with an unread badge on the phone's Today header (the laptop sidebar has a Notifications link, no badge); the **Notifications** screen (`/notifications`, also More → Notifications) lists them newest first, and opening it marks all read. Kept 60 days.
  - **Phone push:** a real notification on every device that turned it on in Settings. Tapping it opens the task (or the inbox when several arrived together). **iPhone needs the app added to the Home Screen and iOS 16.4 or later**; it won't offer push in a normal Safari tab.
  - **Discord DM:** as before.
  - **Send test** (Settings → Notifications) sends one through every enabled channel and shows what reached where.
- **Rules:** quiet hours 23:00–08:00 IST (anything due then waits until morning), one combined DM per check, and each alert sent only once.
- **Status:** Settings → Status (and `/connect` → Alerts) shows when the last check ran and what it did.
- **Setup still to do:**
  1. Add `CRON_SECRET` in Vercel; the value is in `work-os/.env.local`.
  2. On cron-job.org, create a job every 15 minutes on `https://work-os-puce-delta.vercel.app/api/cron/alerts` with the header `Authorization: Bearer <CRON_SECRET>`.
  3. For phone push, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel and redeploy, then turn on "Notifications on this device" in Settings on each phone.
  4. If DMs fail with a 403: Discord → Delpat server → Privacy Settings → allow direct messages.

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
- **Delivery:** `lib/notify.ts`. `runAlerts` (alerts.ts) drops alert types switched off, then writes the inbox, sends push, then DMs; a failing channel doesn't block the others.
  - **Settings storage:** `settings` doc `_id: 'notify'` (`channels.push`, `channels.discord`, `kinds.*`; everything defaults on). Alert types and their labels: `ALERT_KINDS`.
  - **Collections:** `notifications` (inbox) and `pushSubs` (one per device, keyed by push endpoint; dead ones are deleted when the push service answers 404/410). Both in `lib/db.ts`.
  - **Push:** the `web-push` package; VAPID keys from env. `public/sw.js` handles `push` and `notificationclick`. Push needs a production build (the service worker is production only).
  - **Last seen:** `markSeen('mcp' | 'discord')` is called from the MCP and Discord routes; the status panel reads it.
  - **UI:** `app/(app)/notifications/`, `components/mobile/bell.tsx` (unread count comes from `useApp()` in `components/app-context.tsx`).

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
  - **Tasks:**
    - Search, Open / Due soon / Waiting / Done tabs, project chips, and open tasks grouped by priority.
    - **Filters** button opens a sheet for project, mode and due. Filters and search live in the URL (`/board?project=…&q=…`), so back works and a filtered view can be bookmarked.
    - Every task row has a **⋯** that opens an **actions sheet**: status, priority, due (Today / Tomorrow / In a week / pick), mode, and a link to the full task.
  - **Task screen** (full screen):
    - One-tap status and priority.
    - Due chips plus the phone's own date picker, start date, estimate, tags.
    - Progress, and the phone's own pickers for project and mode.
    - Blocked reason, links and "waits on" each open a small sheet.
    - Note card, checklist, description, linked tasks, comments, history.
    - A sticky **Mark done** button. The ⋯ menu has Drop, Reopen, Archive and Delete (Delete asks for a reason sheet; it goes to the trash).
    - Each comment in history has a **⋯** that opens Edit / Delete (any comment).
  - **Today extras:** the bell with its unread badge, a **Day Plan** button (the day's schedule as a sheet, tick tasks off) and **Import** (paste a markdown table or JSON of tasks).
  - **Notes:** the same editor, sized for the phone. The list has live search and swipeable chips (Active / Archived / All, projects); **New note** opens a sheet (title, project).
  - **Projects, History, Archive, Hidden work, Recovery, Weekly review, Timetable, Modes:** each has a phone layout with a back button to More, task rows like the Tasks tab, and no horizontal scrolling at 360–412px.
  - **More:** projects with open and late counts, plus History, Hidden work, Weekly review, Timetable, Recovery, Trash, Settings, Notifications, Connect.
  - **Pull to refresh:** pull down at the top of any screen to reload its data (an installed app has no browser refresh). It's ignored while a sheet is open.
- **Offline:** shows a "You're offline" screen.

### Claude Code
- **Phone components:** `components/mobile/`
  - `tab-bar.tsx`: tab bar and `MobileHeader`; the More tab stays highlighted on its sub-screens (`match` list)
  - `quick-add-sheet.tsx`
  - screens: `m-today.tsx`, `m-tasks.tsx`, `m-task-row.tsx`, `m-task-actions.tsx` (⋯ sheet), `m-task-detail.tsx`, `m-notes.tsx`, `m-day-plan.tsx`, `m-import.tsx`
  - **Shared pieces:**
    - `sheet.tsx` → `BottomSheet`: partial-height sheet for menus, pickers, confirmations
    - `full-sheet.tsx` → `FullSheet`: full-height sheet with a pinned footer, for long forms
    - `sub-header.tsx` → `SubHeader`: 44px back button and big title for screens reached from More (`back` / `backLabel` for other parents)
    - `use-phone.ts` → `usePhone()`: true below 768px, false during SSR; use it only when JS must branch (otherwise use CSS)
    - `bell.tsx` → `BellButton`; `pull-to-refresh.tsx` → `PullToRefresh`, mounted once in `app/(app)/layout.tsx` on `#app-main`
- **Conventions for new phone work:**
  - Phone UI goes inside `md:hidden`, desktop inside `hidden md:block`. Never change the desktop view when adding a phone one.
  - Every tap target is at least 44px (`h-11 w-11` / `min-h-11`).
  - Every sheet or overlay carries the `data-sheet` attribute (the shared sheets already do), or pull to refresh will fire while you scroll it. Portal sheets to `<body>`: sticky/blurred parents trap `fixed`.
  - Prefer the shared components above over new ad-hoc ones. Filter and tab state that should survive back/refresh belongs in the URL.
  - Check at 360, 390 and 412px, light and dark, for horizontal overflow.
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

## 9. Settings

### Om
Settings (`/settings`; phone: More → Settings, laptop: sidebar "Settings & status") has five groups:
- **This device:**
  - **Install app:** one tap on Android/Chrome; on iPhone it shows the steps (Share → Add to Home Screen). Reads "Installed" once you're in the installed app.
  - **Notifications on this device:** switch to turn phone push on or off for this phone only. On iPhone it asks you to install first.
- **Notifications:** switches for the channels (In-app inbox is always on; Phone notifications; Discord DMs) and for each alert type (Unblocked, Overdue, Due today, Due tomorrow, P1 not started, Stalled), plus **Send test**. Details in section 7.
- **Security:** passkeys, authenticator app, change password, test email (section 10).
- **Status:** a live list, each row a coloured dot (green ok, amber needs attention, red broken, grey off):

| Row | What it checks |
|---|---|
| Database | pings MongoDB; amber if slower than 150 ms; shows the task count |
| Server | Vercel region and commit; amber if not Mumbai (`bom1`) |
| Claude connector | `MCP_TOKEN` set; when the connector was last used (amber until first use) |
| Discord bot | token works, channels readable, Message Content Intent on, blocked-channel count, last command; grey if not configured |
| Scheduled alerts | `CRON_SECRET` set and the cron job's last run (amber if never or stale) |
| Phone notifications | VAPID keys set and how many devices are subscribed |
| Notes converter | the markdown ↔ blocks converter loads and works |

- **App:** Appearance (light / dark), a link to `/connect` (Claude, Discord and alerts setup), Sign out.

### Claude Code
- **Page:** `app/(app)/settings/page.tsx`; the device card, push and notification switches are client components in `device-settings.tsx`; server actions in `settings/actions.ts` (subscribe, unsubscribe, save switches, send test).
- **Status:** `lib/status.ts` → `systemStatus()`, run on every page view inside `Suspense`; each probe has a time limit so a dead service can't hang the page. To add a row, push a `Check` (`name`, `level`, `summary`, `detail`) there.
- **Install and push detection:** in `device-settings.tsx` (iOS, standalone, push support).

---

## 10. Login and security

- **Web app:** password login with a signed 60-day cookie. `proxy.ts` protects every page and API.
- **Routes that check their own credentials instead:**
  - `/api/mcp`: `MCP_TOKEN` header
  - `/api/discord/interactions`: Discord signature
  - `/api/cron/alerts`: `CRON_SECRET`
  - the PWA files: public
- **Admin endpoints** (`/api/admin/*`) accept the `MCP_TOKEN` header. Claude Code keys (section 3) work on `/api/mcp` only.
- **The repo is public.** Secrets live only in Vercel and in the gitignored `.env.local`. Before each push, a scan checks that no secret is being committed.
- **Discord:** only Om's user ID, only in the Delpat server, sensitive channels blocked. The bot's permissions are View Channels and Read Message History only.

### Passkeys, authenticator app, password reset

**Om:** Settings → Security.
- **Passkeys:** tap *Add passkey* on each device (name it first). The login page then offers *Sign in with passkey*, and the password field suggests passkeys. Passkey sign-in skips the code step. A passkey works only on the domain it was made on (production, or `localhost` in dev).
- **Authenticator app (TOTP):** *Turn on* shows a QR code and key; confirm one code, then save the 10 recovery codes (shown once). From then on, password sign-in asks for a code (or a recovery code). Turning it off or making new recovery codes needs a current code.
- **Lockout:** 10 wrong passwords/codes in 15 minutes from one IP locks password/code sign-in for that IP until the window passes (plus a 300-per-15-min global backstop). Reset-link requests and bad reset links count too. Passkeys are never locked.
- **Forgot password:** login page → *Forgot password?* → *Email me a reset link*. The link goes to `OWNER_EMAIL` (else `EMAIL_FROM`), works once, for 15 minutes. A new request never cancels a live link, and no new email goes out within 2 minutes of the last one. The page always shows the same message. The reset page asks for the new password twice (10+ characters) and, if the authenticator app is on, a current code or a recovery code. Afterwards every device is signed out and you get an email and an inbox notice.
- **Change password:** Settings → Security → Password → *Change* (current password, new one twice, code if TOTP is on). Other devices are signed out; this one stays in. *Send test email* on the Email row checks the SMTP settings.

**Claude Code:**
- `lib/passkeys.ts` (SimpleWebAuthn): user verification (biometric/PIN) is required. RP ID/origin in production come from `APP_URL`, else `https://$VERCEL_PROJECT_PRODUCTION_URL` (Vercel system var); passkeys fail with a clear error if both are missing. A `localhost` Host header (never `x-forwarded-host`) is used in dev, or in `next start` when neither is set. Challenges live in `authChallenges` for 5 minutes and are deleted when checked (single-use, TTL index); each IP holds at most 20 open sign-in challenges.
- `lib/totp.ts` (otplib + qrcode): the secret sits in `settings` `_id: 'security'`, AES-256-GCM encrypted with a key derived from `SESSION_SECRET` (rotating it breaks TOTP: turn TOTP off first). Recovery codes are stored as HMACs. App codes can't be replayed (`lastStep`). Failures go to `authFailures` keyed by client IP (first `x-forwarded-for` entry), TTL 15 min.
- `lib/auth.ts`: same session cookie for every method; `workos_2fa` is a 5-minute signed "password OK, needs code" cookie scoped to `/login`. The session cookie is `v2.<gen>.<exp>.<sig>`; `verifySessionValue` also requires `gen` to equal `settings` `{_id:'security'}` `sessionGen` (cached 5 s per server instance, so other instances notice a sign-out-all within 5 s; fails closed if Mongo is down). Old `v1` cookies are accepted only while `sessionGen` is 0.
- `lib/password.ts`: `checkPassword` uses `passwordHash` in the security doc (scrypt N=2^15 r=8 p=1, 16-byte salt, params stored in the hash) when present; `APP_PASSWORD` only when no hash is stored. `setPassword` stores the hash and bumps `sessionGen` (signs out every session).
- `lib/password-reset.ts`: 32 random bytes (base64url) per link; only the SHA-256 is stored in `passwordResets` (TTL index on `expiresAt`, 15 min). Each request deletes older tokens, records an `authFailures` entry (`kind: 'reset'`, per-IP limit) and takes a `mailLog` slot (3 reset emails/hour globally; test emails 5/hour). The token is claimed with `findOneAndDelete` after the password and TOTP checks. Link origin follows `relyingParty()` in `lib/passkeys.ts` (`APP_URL`, else `https://$VERCEL_PROJECT_PRODUCTION_URL`, localhost only in dev or when neither is set); if none fits, no email is sent.
- `lib/mail.ts` (nodemailer, pinned): SMTP from `EMAIL_*`; mail only ever goes to `OWNER_EMAIL`/`EMAIL_FROM` (no "to" parameter). Missing vars fail with their names (never values).
- Sign-in actions are server actions in `app/login/actions.ts`, so they POST to `/login`. `proxy.ts` allows exactly `/login` and `/login/reset` (the reset page, `app/login/reset/page.tsx`, `Referrer-Policy: no-referrer`); no other public route.
- Settings UI: `app/(app)/settings/security-settings.tsx` + `security-actions.ts` (every action re-checks the session). Only `SafeError` messages (`lib/auth.ts`) reach the browser; other errors are logged and shown as a generic message.
- **Locked out with TOTP and no passkey or recovery code:** in Mongo, set `settings` `{_id:'security'}` `totp` to `null`.
- **Forgot the password and email is broken:** in Mongo, unset `settings` `{_id:'security'}` `passwordHash`; `APP_PASSWORD` works again.

---

## 11. Still to do / known limits

**For Om:**
1. **PC:** move the Windows pagefile from C: to D: and restart. C: keeps filling up because of it.
2. **Alerts:** add `CRON_SECRET` in Vercel and create the cron-job.org job (section 7).
   - Also add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Vercel for phone push.
3. **Discord:**
   - Tick sensitive channels on `/connect`.
   - Change the dev@ and tools@ passwords, which were posted in #our-own-system-automation.
   - If `/today` says "did not respond", set the Interactions Endpoint URL in the Discord Developer Portal to `https://work-os-puce-delta.vercel.app/api/discord/interactions`.
4. **Claude:** paste the updated morning-brief prompt from `/connect` into the 8am brief.
5. **Deploy:** notifications, inbox, Settings and the phone screens above are committed or in the working tree but **not deployed yet**; an interaction pass (New note sheet) was still to finish before pushing.
6. **Phone:** install it and report anything that feels off. It was tested in an emulated iPhone, not on a real device.

**Known limits:**
- **Simultaneous edits:** if Claude edits a note you have open, your last few seconds of typing are lost when the page reloads (you're warned first).
- **Pre-existing lint errors** in `today-client.tsx`, `current-block-bar.tsx` and `api/timetable/today` are untouched.
- **Images and files** in notes are off until Blob storage is set up.

---

## 12. Working on the code (Claude Code)

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
