# Work OS: handover

Work OS is Om's task system: tasks, projects, Notion-style notes, Discord and alerts, used from a laptop, a phone and by Claude.

- Live app: https://work-os-puce-delta.vercel.app
- Code: https://github.com/roguetitan1703/work-os (public; no secrets in it)
- Hosting: Vercel (Node 22). Database: MongoDB Atlas. Pushing to `master` deploys.
- Moving to EC2 at work.delpat.in (phase 5): runbook, deploy files and the one-time cut-over in `docs/hosting.md`.

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
| `BETTER_AUTH_SECRET` | signs sign-in cookies and hashes tokens (32+ random characters; `SESSION_SECRET` is read if missing). Sign-in is by user: `docs/auth.md` | yes |
| `APP_TZ` | Default timezone for people who have not set their own (else UTC); each person sets theirs in Settings › Alerts | no |
| `APP_URL` | public base URL: sign-in cookies, passkeys, reset and invitation links, links sent to Claude and Discord | yes |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | The Discord bot (each organization's server and each person's account are set in the app: docs/multi-user.md phase 3) | for Discord |
| `DISCORD_BLOCKED_CHANNELS` | extra channel ids never to read (comma-separated); normally managed in Settings › Connections › Discord instead | optional |
| `CRON_SECRET` | protects the alert check endpoint | for alerts |
| `OPERATOR_EMAILS` | who runs the deployment (comma list): health, Discord registration, Settings › Usage, the built-in schedule (`lib/operator.ts`) | yes (Om's email) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | keys for phone push (a `mailto:` address for the subject). **Must be added on Vercel**; copy the values from `.env.local`. Without them push is off and Settings → Status says so | for phone push |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | SMTP for "Forgot password?" links, invitations, password-change emails and the Settings test email. `EMAIL_SECURE=true` = TLS from the start (port 465); otherwise STARTTLS is required. **Must be added on Vercel**; copy the values from `.env.local` | for password reset |
| `OWNER_EMAIL`, `OWNER_NAME` | used only by `scripts/migrate-auth.mjs` (the first user) | for the migration |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private) for images and files in notes | not used yet |
| `MCP_ALLOW_URL_TOKEN` | `1` allows putting a Claude chat key in the URL (`/api/mcp/<key>`) instead of a header | leave unset |
| `INVITE_LINK_TO_INVITER` | `0` sends invitation links only by email (the inviter never sees them); unset or `1` also shows the link to whoever invites (docs/auth.md) | default: shown |

**Health check:** `GET /api/admin/health` with `Authorization: Bearer <Claude chat key of an owner or admin>` returns database status, document counts, the Node version, and whether the note converter works.

---

## 2. Tasks and projects

### What a task has
A number (`#12`), title, description, project, mode (type of work), priority P1–P4, status (Not Started, In Progress, Blocked, Done, Dropped), tags, start and due dates, estimate, progress %, checklist, links, blocked reason, dependencies ("waits on #5"), a repeat schedule (daily, weekdays, weekly or monthly; the next one is created when it's completed) and archived. Every change is written to the task's **history**, which records who made it: **You**, **You · Discord**, **Claude**, **Claude Code** or **System**.

### Om
- **Laptop:**
  - **Today:** schedule, current time block, overdue, in progress, blocked.
  - **Board:** columns by status, with filters.
  - **Projects:** progress per client.
  - **Task page:** edit everything inline, log progress, checklist, comments, history.
  - **Review** (`/review?view=done|activity|stale|archive|trash`, sidebar and phone Menu): Done, Activity (filter by you, Discord or Claude), Stale (untouched 14+ days), Archive (Restore on each row, with Undo), Trash (Restore, Delete forever). `/history`, `/hidden` and `/archive` redirect here. The weekly review, the daily routine card and per-person help text were one person's setup and were removed (2026-10-26); their old documents (reviews, ritualLogs) stay in the database, unread.
- **Quick add:** press **N** anywhere. You can type it all in one line:
  - `Send invoice @"Grant Leads" !1 #billing due:fri ~20m mode:admin`
  - That reads as: `@project`, `!1`–`!4` for priority, `#tag`, `due:`, `start:`, `~20m` for the estimate, `mode:`.
  - **Repeat:** `every:day`, `every:weekday`, `every:week`, `every:2w`, `every:month` (also `every:3d`, `every:2m`) make a recurring task; an unknown value stays in the title. Discord `/task` has a `repeat` choice; MCP `add_task` takes `recurrence`. The New task form (Shift+Enter) and the task page have a Repeats select. Recurring tasks show a small repeat icon on rows, board cards and Today rows (`lib/recurrence-options.ts` holds the choices).
- **Completing a recurring task** creates its next occurrence automatically.
- **Reopening a done task** restores its earlier progress. It no longer stays at 100%.

### Delpat OS import (2026-10)
- **Om:** Settings › Connections › **Delpat OS** › Link (once per person; sign in at Delpat OS and allow). Then New project › **From Delpat OS**: search your Delpat OS projects and press Import. Name, client, status and a description (focus and phases) are filled; it is Shared unless you pick Private. An imported project shows "Already in Work OS" next time. Hidden until `DELPAT_OS_CLIENT_SECRET` is set on the server.
- **Claude Code:** `lib/delpat-os.ts` (everything), `docs/auth.md` "Linking Delpat OS" (security design), `ProjectDoc.delpatOsId` (unique per organization). Env in `docs/hosting.md`. Tests `delpat-os` and `delpat-os-off`.

### Claude
`list_tasks`, `get_task`, `add_task`, `update_task`, `log_progress`, `complete_task`, `add_comment`, `update_checklist`, `list_projects`, `add_project`, `update_project`, `daily_summary`, `recent_activity`.
- **`daily_summary`** is the one call for a morning brief: overdue, due today, in progress, blocked and waiting, the next 7 days, everything completed or changed since the last workday and who did it, and per-project counts.
- **Dates** accept `today`, `tomorrow`, weekday names, `+3d`, `+2w` or `YYYY-MM-DD`.
- **Assignee** (phase 4): `add_task`, `update_task` and the batch task ops take `assignee` ('me', an email or a user id; null clears), only on tasks in shared projects; `list_tasks` filters by it, and task answers show it as 'me' or a name.
- **Shared and private projects** (UI): the New project dialog and sheet have a Shared / Private choice (default Shared; help line under it). Project › Info › "Who sees it" switches it (`updateProjectAction` → `updateProject`, which cascades to tasks, notes, Claude items, history and trash, and drops other assignees when made private). Only the project's owner may switch (data layer refuses others; the choice is disabled for them). Shared → Private asks first when someone else is assigned or has commented (`projectSharingImpact`, `projectSharingImpactAction`): they lose access, their assignments are removed, their queued or running Claude tasks in it end (`endForeignClaude` in dispatcher.ts: queued mark cleared, running one stopped with a stop job) and Claude items waiting on them stop waiting. A "Private" badge (`components/private-badge.tsx`, lock icon, `data-private-badge`) shows on private projects in the projects list, project header, task rows and pages, start-Claude picker, Tasks/Notes pickers and filters; shared ones show nothing. `scripts/migrate-ownership.mjs` now makes old projects private (owner: the first owner), so the owner shares them one by one. Tested by `tests/e2e/sharing.mjs`.

### Claude Code
- **Data layer:** `lib/data/tasks.ts` (create, update, history, recurrence, queries) and `lib/data/projects.ts`. Pages, server actions (`app/actions.ts`), MCP and Discord all go through it.
- **Types:** `lib/types.ts` (zod schemas). Stored document shapes and indexes: `lib/db.ts`.
- **History:** entries in `activity` are written by `logActivity()`; display text comes from `lib/activity-text.ts`.

---

## 3. Claude connector (MCP)

### Om
- **Connecting (OAuth, no key):** claude.ai → Settings → Connectors → Add custom connector → URL `https://work.delpat.in/api/mcp` (leave client ID and secret empty) → Connect. Work OS asks you to sign in, then shows *"Claude wants to access your Work OS as you in <organization>"* with Allow / Deny. Claude Code: `claude mcp add --scope user --transport http work-os https://work.delpat.in/api/mcp`, then `/mcp` → work-os → Authenticate (or `claude mcp login work-os`). Settings › Connections › *Signed-in apps* lists them (when, last used) with Revoke. Details, security rules and tests: `docs/auth.md` "Connecting Claude with OAuth".
  - *Advanced: API keys* (same page): the old `Authorization: Bearer <key>` way, for the worker, scripts and clients that cannot sign in.
- **Settings › Connections** (`/settings?section=connections`; the old `/connect` redirects there) has:
  - the URL and header with copy buttons (the key is hidden until you click reveal)
  - instructions to paste into a Claude Project or your preferences
  - every tool with a description and an example question
  - Discord setup with live status
  - (alert settings and status live in Settings › Alerts)
- **To disconnect:** Revoke the app in Settings › Connections › Signed-in apps (or revoke the API key, if you used one).

### Claude
- **Every write is attributed to Claude** in history. It records the key's owner: a teammate's key shows as "Claude · <name>".
- **The connector acts for the key's owner in their organization.** It sees shared work plus that person's private things, nothing else. MCP field changes from phase 2 are listed in `docs/multi-user.md` ("As built: phase 2"):
  - `waitingOnOm` became `waitingText` + `waitingOn`, and the `waiting_on` arg was added;
  - `visibility` was added;
  - `by` holds names for other people.
- **The connector tells Claude how to behave:**
  - Refer to tasks as `#12`.
  - Add a short note to writes.
  - Use `log_progress` and `complete_task`.
  - Use `apply_changes` for multi-step work and `get_project` for overviews.
  - Update an existing note before creating a new one.

### Claude Code
- **Endpoint:** `app/api/mcp/[[...key]]/route.ts`. Stateless Streamable HTTP. `Authorization: Bearer` takes an OAuth access token (`wosat_…`, `lib/oauth.ts`) or an API key (`wos_…`, also `X-API-Key`); no or bad credentials get 401 with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`. An OAuth client counts as a Claude chat key only when all its registered redirect addresses are claude.ai's callback; any other client gets the Claude Code rules.
- **Tool handlers:** `lib/mcp/server.ts`.
- **Tool titles, descriptions and server instructions:** `lib/mcp/docs.ts`. This one file feeds both MCP and Settings › Connections, so edit descriptions there.
- **Adding a tool:** add its name to `ToolName` and an entry in `TOOLS` (docs.ts), register it with `tool(...)` in server.ts, and add it to `ORDER` in `app/(app)/connect/page.tsx`.
- **Smoke test:** `node scripts/test-mcp.mjs <url>/api/mcp <Claude chat key> [--write]`.

### Claude Code keys
- **Om:** `/claude?tab=setup` → **Keys** (Claude area; `/connect?tab=code` redirects there): name a key, **Create**, copy it (shown once) or the ready `claude mcp add --transport http work-os <url> --header "Authorization: Bearer <key>"` command. The list shows prefix, created and last used; **Rotate** (old key dies, new one shown) and **Revoke**. Changes made with a key show as **Claude Code** in history (filter "By Claude Code"), with the `X-Work-OS-Repo` / `X-Work-OS-Session` headers shown small next to them if the session sends them.
- **What a key can do:** everything the claude.ai connector can (projects, tasks, notes, trash, Discord reads; the channel blocklist still applies). **Claude Code keys work on `/api/mcp` only**; Claude chat keys also on the other API routes (admin needs an owner or admin). Keys are Better Auth API keys owned by a user in an organization (`docs/auth.md`).
- **Rules** (`lib/mcp/policy.ts`, a no-op for Claude chat keys): no permanent deletion/admin tools or ops; 300 tool calls per rolling hour per key; 10 trashes per 10 minutes; an `apply_changes` that trashes > 10 items or changes > 50 tasks needs a dry run first, whose `confirm` token (HMAC of the ops + 10-minute expiry, `BETTER_AUTH_SECRET`) the real call must pass. When a key changes title/priority/due/project of, or trashes, a task it didn't create, Om gets one inbox notice per call (Settings → Notifications → "Claude Code changes", default on).
- **Code:** `lib/api-keys.ts` (Better Auth apiKey plugin, `wos_` + 48 characters, hashed; `metadata: {agent, orgId}`), `lib/caller.ts` `verifyKey`, `lib/mcp/policy.ts` (counters in `policyEvents`, TTL 2h; `Caller` = `{agent, keyId, keyName, userId, orgId}`, `callerScope`), `lib/request-context.ts` (session/repo headers → `logActivity`), UI `app/(app)/claude/keys.tsx` + `setup-actions.ts`.
- **Turbo mode (clone, link, start):** Start Claude / a dispatched task on a project whose repo is not on the PC makes the worker clone it into its projects folder, link it and start. Spec, guards and flow: `docs/launcher.md` "Turbo mode". Worker side `worker/clone.mjs` (URL rules, destination, git args, timeout; unit tests `worker/test/clone.test.mjs`); server `lib/data/turbo.ts` (who may, `turboStart`, `turboInfo`, dispatcher plan), jobs carry `clone: { repo }`, sessions `cloning`/`repo`, devices report `worker.allowClone`/`projectsDir`; code locations keep a non-GitHub `host`. UI: start sheet, Info › Code lines (`folders.tsx` TurboLines). e2e `tests/e2e/turbo.mjs`.
- **Project code locations:** projects have `code: [{remote, subdir?, branch?} | {path}]` (project page → Code locations, or `add_project` / `update_project` / batch ops). Remotes are stored as lowercase `owner/name`, credentials stripped. `get_project` with `remote`/`subdir`/`branch`/`path` instead of a name picks the most specific match (remote+subdir+branch > remote+subdir or +branch > remote > longest path), else returns `unmatched` with candidates. A branch ending in `*` matches by prefix (`wt/ana*`). Matcher: `lib/data/code-locations.ts` (pure functions).

---

## 4. Batch changes, full project view, trash

### Om
- **Search:** the search icon in phone headers, the sidebar Search button, `/` and `Ctrl+K` (desktop) open one search over tasks (title, `#12`), projects (name, client), notes (title, text) and Claude items (title, `C12`), 6 per group (`lib/data/search.ts`, server action `app/(app)/search-action.ts`, `components/global-search.tsx`). Up/Down/Enter on desktop. The Tasks page keeps its own filter box.
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
  3. Nothing else is needed: the routes `app/api/notes/upload` and `app/api/notes/file` already exist. Files are stored per note (`notes/<orgId>/<noteId>/<name>`) and served only to people who can see that note; only common image types show inline (`lib/note-files.ts`, docs/multi-user.md).

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
- **Sensitive channels:** Settings › Connections → Discord → "Sensitive channels: never read". Tick channels or whole categories, then Save. They're never listed or scanned, and links or right-clicks into them are refused.
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
- **Registering commands:** `POST /api/admin/discord/register` with a Claude chat key of an owner or admin, scoped to the Delpat server. Re-run it whenever commands change.
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
- **Status:** Settings › Alerts (and the status strip at the top of Settings) shows when the last check ran and what it did.
- **Setup still to do:**
  1. Add `CRON_SECRET` to `/etc/work-os/env` on the server and restart `work-os`. `work-os-alerts.timer` (see `docs/hosting.md`) then calls the check every 15 minutes; check it with `systemctl list-timers 'work-os*'` and `journalctl -u work-os-alerts`.
  3. For phone push, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` to `/etc/work-os/env` and restart, then turn on "Notifications on this device" in Settings on each phone.
  4. If DMs fail with a 403: Discord → Delpat server → Privacy Settings → allow direct messages.

### Claude
Nothing to call; alerts run on their own. Claude's own changes trigger them like anyone's: when Claude completes a blocking task, the unblocked alert goes out (to the waiting task's owner, or its assignee).

**Per person (phase 2):**
- Every alert has a recipient: the assignee of a shared task, else its owner (`recipientOf` in lib/data/tasks.ts). Assigning someone sends them "Assigned to you" at once (phase 4); an assignee's alert log keys carry their user id, so a task that changes hands alerts its new recipient.
- The cron runs once per member, each with their own settings (`notify:<userId>`), inbox and push devices.
- The Discord DM goes only to the Discord-linked person.

### Claude Code
- **Logic:** `lib/alerts.ts`. The thresholds are in `ALERT_RULES`.
  - `alertLog`: one record per alert sent, so each goes out once.
  - `alertQueue`: unblocked alerts waiting to be sent.
- **Queueing:** `queueUnblocked()` is called from `updateTask` **inside** the same transaction as the write, so a batch that rolls back never queues an alert.
- **Sending soon after a write:** `flushQueuedAlerts()` runs via `after()` in the MCP route, the Discord interactions route and the app's server actions.
- **Exactly once, even when runs overlap:** a run claims each alert before delivering it (queue entry: `sentAt: null` → now, conditional update; scheduled alert: insert into `alertLog`, duplicate key = another run has it). Several flushes after a batch plus the cron can no longer send the same alert twice. A claimed alert stays sent even if a channel then fails.
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

### Tasks for Claude (dispatcher)

**Om:** on a task (page, row menu) choose **Give to Claude**; if the project has several linked folders you pick one. Claude › Setup › Tasks for Claude has the on/off switch (off by default), how many sessions at once (default 2) and the note every session reads first. When a computer has room, its worker starts a Claude Code session on the oldest task you gave; the **Claude's tasks** section on Claude › Now shows working, queued and recently finished or stopped. You get one alert when it finishes ("Claude finished #12") or stops ("Claude stopped on #12: reason") and one if it goes quiet 20 minutes ("may be stuck"). **Take back** works any time (a running one stops its session). Only you can give or take back; Claude, Discord and batch changes cannot.

**VS Code and reopen after a restart:** Sessions on the Claude page (and the project's) have **Open in VS Code** (the PC runs `Code.exe <folder>` then the `vscode://anthropic.claude-code/open?session=<id>` link; VS Code asks Om once to allow it). After a crash or restart the worker offers "N sessions were open before your PC restarted" with **Reopen all** / **Dismiss**; each reopens where it was made (VS Code or terminal), never without the tap. Details, trust checks and what was not verified: `docs/launcher.md` "VS Code and Reopen after a restart"; code `worker/vscode.mjs`, `worker/openset.mjs`, `locate()` in `worker/core.mjs`, server `lib/data/launcher.ts` (`openSessionInVscode`, `reopenAll`, `reopenPrompts`), UI `app/(app)/claude/reopen-banner.tsx`; e2e `tests/e2e/vscode-reopen.mjs`.

**Claude Code:** design, rules and what differs from the plan are in `docs/dispatcher.md` ("As built"). All logic is `lib/data/dispatcher.ts`; `claude` on a task is written only by `app/(app)/claude/dispatcher-actions.ts` (session cookie) and the dispatcher; `updateTask`/`createTask` never touch it. The claim runs in `GET /api/worker/jobs` (`dispatchFor`), outcomes are settled on worker status, task changes and the alerts cron (`reconcileDispatched`). Test with a throwaway mongod replica set and a fake device key (never the real database).

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
  - **Projects, History & trash, Untouched, Recovery, Timetable, Modes:** each has a phone layout with a back button to More, task rows like the Tasks tab, and no horizontal scrolling at 360–412px.
  - **More:** projects with open and late counts, plus History & trash, Untouched, Timetable, Recovery, Notifications, Settings, Connect.
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
Settings (`/settings`; phone: More → Settings, laptop: sidebar "Settings") has four groups:
- **This device:**
  - **Install app:** one tap on Android/Chrome; on iPhone it shows the steps (Share → Add to Home Screen). Reads "Installed" once you're in the installed app.
  - **Notifications on this device:** switch to turn phone push on or off for this phone only. On iPhone it asks you to install first. Under it, the list of your own push devices (name, added date, "this browser"), each with Remove, e.g. a phone set up on an old address of Work OS. Only your own appear.
- **Notifications:** switches for the channels (In-app inbox is always on; Phone notifications; Discord DMs) and for each alert type (Unblocked, Overdue, Due today, Due tomorrow, P1 not started, Stalled), plus **Send test**. Details in section 7.
- **Security:** passkeys, authenticator app, change password, test email (section 10).
- **Status (on Connect):** a live list, each row a coloured dot (green ok, amber needs attention, red broken, grey off):

| Row | What it checks |
|---|---|
| Database | pings MongoDB; amber if slower than 150 ms; shows the task count |
| Server | the release commit (from the `REVISION` file) and Node version |
| Claude connector | when a Claude chat key was last used on the connector (amber until first use) |
| Discord bot | token works, channels readable, Message Content Intent on, blocked-channel count, last command; grey if not configured |
| Scheduled alerts | `CRON_SECRET` set and the alerts timer's last run (amber if never or stale) |
| Phone notifications | VAPID keys set and how many devices are subscribed |
| Notes converter | the markdown ↔ blocks converter loads and works |

- **App:** one Settings page with sections This device (push, theme, test, sign out), Alerts, Security, Connections (Claude chat, Discord; Claude Code keys and computers are in Claude › Setup), Usage and Help; status strip on top.
- **Usage:** our own request log, requests in the last 24 h and 7 days, per hour, per day, and the top routes by kind (page load, page data, action, API) and caller (browser, worker, Claude, cron, Discord, no sign-in). Static files are not counted. How it works: `docs/usage-log.md` (`proxy.ts` → `lib/usage.ts` → `requestStats`, 35 days).

The live status list (below) is the status strip at the top of Settings.

### Claude Code
- **Page:** `app/(app)/settings/page.tsx`; the device card, push and notification switches are client components in `device-settings.tsx`; server actions in `settings/actions.ts` (subscribe, unsubscribe, save switches, send test).
- **Status:** `lib/status.ts` → `systemStatus()`, run on every page view inside `Suspense`; each probe has a time limit so a dead service can't hang the page. To add a row, push a `Check` (`name`, `level`, `summary`, `detail`) there.
- **Install and push detection:** in `device-settings.tsx` (iOS, standalone, push support). The push device list is `listPushDevices` / `removePushDevice` in `lib/notify.ts` (scoped door; the list id is a hash, the endpoint stays on the server).
- **Dropdowns:** every `<select>` but the phone task screen's uses `components/ui/select.tsx` (Base UI, same `<option>` children and `onChange`); e2e suites choose with `pick()` in `tests/e2e/lib.mjs`.
- **Password again:** one modal for every action that needs it (`components/reauth.tsx`: `ask()` for freshness, `askPassword()` when the action needs the password itself: authenticator, password change).
- **Worker install, Replace key, autostart:** `docs/launcher.md` "Installing without the repo"; Settings › Connections lists your computers (`connections-computers.tsx`), Claude › Setup › Computers manages them (Replace key, Folders and their projects), Project › Info › Code holds the repository and folder links.
- **Usage:** `usage-section.tsx` reads `lib/data/usage.ts`; counting happens in `proxy.ts` (see `docs/usage-log.md`). New routes go in the route table in `lib/usage.ts`, or they count as `(other)`.

---

## 10. Login and security

Full details: **`docs/auth.md`** (sign-in, roles, invitations, keys, the one-time migration, environment).

- **Web app:** sign-in by user (Better Auth): email + password, authenticator app with backup codes, passkeys,
  "Forgot password?" to your own email. Sign-up is closed: people join through an invitation (Settings › Members).
  Roles: owner, admin, member. Every request knows who (`getCaller()` in `lib/caller.ts`); history records `actorUserId`.
  Owners and admins change roles and remove members there (phase 4: the last owner stays; removal ends the person's
  sessions, keys, computers and Claude claims in that organization; docs/multi-user.md "As built: phase 4").
- **`proxy.ts`** protects every page and API using Better Auth's signed cookie cache (no database read for most
  requests; a revoked session can open pages for up to 2 minutes). Public: `/login`, `/login/reset`,
  `/accept-invitation/<id>`, the PWA files.
- **Routes that check their own credentials:** `/api/mcp` (Claude chat or Claude Code key), `/api/worker/*`
  (`wkr_` device key), `/api/discord/interactions` (Discord signature), `/api/cron/alerts` (`CRON_SECRET`),
  `/api/auth/*` (Better Auth, allowlisted endpoints only). The proxy still counts them for Settings › Usage
  (`docs/usage-log.md`).
- **Admin endpoints** (`/api/admin/*`): a signed-in owner or admin, or their Claude chat key.
- **The repo is public.** Secrets live only in Vercel and in the gitignored `.env.local`. Before each push, a scan checks that no secret is being committed.
- **Discord:** only Om's user ID, only in the Delpat server, sensitive channels blocked. The bot's permissions are View Channels and Read Message History only. Discord commands are not tied to a Work OS user yet (no `actorUserId`).

---

## 11. Still to do / known limits

**For Om:**
1. **PC:** move the Windows pagefile from C: to D: and restart. C: keeps filling up because of it.
2. **Alerts:** add `CRON_SECRET` in Vercel and create the cron-job.org job (section 7).
   - Also add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Vercel for phone push.
3. **Discord:**
   - Tick sensitive channels in Settings › Connections › Discord.
   - Change the dev@ and tools@ passwords, which were posted in #our-own-system-automation.
   - If `/today` says "did not respond", set the Interactions Endpoint URL in the Discord Developer Portal to `https://work-os-puce-delta.vercel.app/api/discord/interactions`.
4. **Claude:** paste the updated morning-brief prompt from Settings › Connections into the 8am brief.
5. **Deploy:** notifications, inbox, Settings and the phone screens above are committed or in the working tree but **not deployed yet**; an interaction pass (New note sheet) was still to finish before pushing.
6. **Phone:** install it and report anything that feels off. It was tested in an emulated iPhone, not on a real device.

**Known limits:**
- **Simultaneous edits:** if Claude edits a note you have open, your last few seconds of typing are lost when the page reloads (you're warned first).
- **Pre-existing lint errors** in `today-client.tsx`, `current-block-bar.tsx` and `api/timetable/today` are untouched.
- **Images and files** in notes are off until Blob storage is set up.

---

## 12. Working on the code (Claude Code)

- **Read first:** `AGENTS.md`. This Next.js (16.4) has breaking changes; docs are in `node_modules/next/dist/docs/`.
- **Security headers (red-team R2-01):** every page gets a Content-Security-Policy with a fresh nonce from `proxy.ts` (`pageCsp`): scripts only with the nonce (`'strict-dynamic'`), styles `'unsafe-inline'` (React style attributes, sonner, BlockNote), images and media from any https address, never framed. The root layout reads the nonce for next-themes' inline script, so every page renders per request. `next.config.ts` adds `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on `/login/reset`) and a `Permissions-Policy` to everything. A new third-party script, frame or upload host needs a line in `pageCsp`. `images.unoptimized` is on (no `next/image`; `/_next/image` answers 404). Task links are http(s) or mailto only (`linkSchemeAllowed` in `lib/types.ts`, again in `normalizeUrl`). `tests/e2e/headers.mjs` checks all of it.
- **Data access (phase 2, `docs/multi-user.md` "As built"):** every data function takes the caller's scope `{ userId, orgId }` first. Every query goes through `scoped(scope)` in `lib/scope.ts`.
  - Pages use `requireScope()` (lib/caller.ts); actions use `asCaller(c => …)` or `run((s, me) => …)`.
  - `tests/scope-check.mjs` (runs as `prebuild`) fails on raw `collections()` / `getDb()` / `.collection()` in lib/data, lib/mcp, lib/alerts, lib/notify, lib/discord, lib/status and app/, unless the line says `// scope-ok: <reason>`.
  - Actors are objects (`lib/actors.ts`). Show them with `<ActorName>` / `<ActorBadge>` (components/actor-badge.tsx), never as raw strings.
- **Migration from single-owner data:** `node scripts/migrate-ownership.mjs --db <name>` (dry run, counts only) → `--copy-to <scratch db>` to rehearse on a copy → `--apply`. Run it right after deploying phase 2.
- **Checks before pushing:**
  - `npx tsc --noEmit -p .`
  - `npx eslint <touched files>`
  - `npx next build`
- **Pushing to `master` deploys.** Then check:
  - `/api/admin/health`, which should report `notesConverter: "ok"`
  - `node scripts/test-mcp.mjs …`
- **Commits:** no co-author or "Generated with" lines (Om's preference).
- **After a server action:** an action that calls `revalidatePath` already sends the new page back; don't add `router.refresh()` after it (a second refresh is one more request and races the first update). On the Claude page, run writes through `write()` in `app/(app)/claude/auto-refresh.tsx`: the router sometimes leaves the action's new page waiting until another React update (seen on Next 16.2 / its React canary; kept on 16.4, see WORK-STATE), and `write()` re-renders until it shows.
- **Push (phase 5):** open pages and workers hold one Server-Sent Events stream each (`/api/stream`, `/api/worker/stream`; hub `lib/live.ts`). Every write through `lib/scope.ts` hints the people who can read what changed (`pushed()`); the Claude page refreshes on a hint and polls only while its stream is down; workers poll at once on a wake and otherwise every 5 minutes. A write outside the door that pages should see must call `hint()` (or a worker `wake()`) itself. Server needs: `docs/hosting.md` §12 "Push". As built: `docs/multi-user.md` "As built: phase 5 push".
- **End-to-end tests:** `bash tests/e2e/run.sh [suite…]` (throwaway mongod, own ports via `E2E_MPORT`/`E2E_APORT`/`E2E_DPORT`). Each run makes a test owner, organization and Claude chat key (`tests/e2e/lib.mjs` `makeIdentity`); mail goes to JSON files (`MAIL_CAPTURE_DIR`). `auth.mjs` covers sign-in, 2FA, reset, invitations, keys and a no-credentials sweep of every route. `tenancy.mjs` covers two people in one organization plus a second organization: private vs shared, every MCP read tool, pages, search, note files, worker and admin APIs, per-organization numbers and recipients, and (phase 3) each person's own schedule, timezone and dispatcher cap. `sharing.mjs` covers the Shared/Private UI end to end (create private, switch, owner-only, confirm, badge, what a teammate sees). `team.mjs` (phase 4) covers assignees and their alerts, take-back through sub-pages, invitations, roles, the last owner and removing a member. `discord-link.mjs` signs Discord interactions with a throwaway key against a stub Discord: linking, commands acting as the linked person, per-person channel visibility and DMs. Fixtures inserted with `db` from lib.mjs get the test owner's organization and owner filled in (`rawDb` writes exactly what you give it).
- **Testing locally:**
  - **MongoDB:** transactions need a replica set: `mongod --replSet rs0 --port 28020 --dbpath <dir>`, then `replSetInitiate`.
  - **Discord:** set `DISCORD_API_BASE` to a fake Discord.
  - **Alerts:** `/api/cron/alerts?dry=1&at=<ISO>` works outside production.
  - **Phone:** Playwright with a 390×844 touch viewport.
  - **Keep scratch files out of the repo.** Earlier test scripts lived in `work mode os/.scratch-mongo/`.
- **Where to change common things:**
  - Alert rules: `ALERT_RULES` in `lib/alerts.ts`
  - Tool wording: `lib/mcp/docs.ts`
  - Quick-add syntax: `lib/quick-parse.ts`
  - Modes: each organization's list (`modes:<orgId>`, `lib/org-modes.ts`); the default eight and colour helpers in `lib/modes.ts`
  - Schedule: each person's own (`/timetable?edit=1`, `lib/user-schedule.ts`; docs/multi-user.md phase 3)
  - Timezone and quiet hours: each person's own (Settings › Alerts); `APP_TZ` is the default
