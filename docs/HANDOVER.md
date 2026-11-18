# Work OS: handover

Work OS is Delpat's task system: tasks, projects, Notion-style notes, Discord and alerts, used by Om and the team from a laptop and a phone, and by Claude sessions through its MCP connector. What it is for, and which flows are agreed: `docs/PRODUCT.md`.

- Live app: https://work.delpat.in (the old Vercel copy is paused and no longer used)
- Code: https://github.com/roguetitan1703/work-os (public; no secrets in it), mirrored to Delpat-Tech/work-os
- Hosting: Delpat's EC2 box (ap-south-1), Caddy in front, the app under systemd (`work-os.service`, port 3100), own Node 22. Database: MongoDB Atlas. Pushing to `master` does **not** deploy: build on a PC (`scripts/build-artifact.sh`, uploaded to the `manual-builds` release) and run `sudo work-os-update` on the box. Runbook: `docs/hosting.md`.

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

On the box, configuration is in `/etc/work-os/env` (root:workos, 0640; template `deploy/env.template`); restart `work-os` after a change. For local development, copy the same variables into `.env.local`, which is gitignored. `.env.example` lists every variable.

| Variable | What it is | Required |
|---|---|---|
| `MONGO_MONGODB_URI` (or `MONGODB_URI`) | Atlas connection string; both names work | yes |
| `MONGODB_DB` | database name (`workos`) | default `workos` |
| `BETTER_AUTH_SECRET` | signs sign-in cookies and hashes tokens (32+ random characters; `SESSION_SECRET` is read if missing). Sign-in is by user: `docs/auth.md` | yes |
| `MAIL_KEY_SECRET` | seals each person's linked Mailloom key; own secret recommended in production (unset = derived from `BETTER_AUTH_SECRET`, whose rotation then breaks every linked mailbox). With `MAILLOOM_AGENT_URL` (docs/hosting.md) | no |
| `MAILLOOM_CLIENT_ID`, `MAILLOOM_CLIENT_SECRET` | Connect Mailloom (one click; with `MAILLOOM_AGENT_URL` and an explicit `MAILLOOM_WEB_URL`). Unset = only the paste box. Values and Mailloom's matching settings: docs/hosting.md | optional |
| `APP_TZ` | Default timezone for people who have not set their own (else UTC); each person sets theirs in Settings › Alerts | no |
| `APP_URL` | public base URL: sign-in cookies, passkeys, reset and invitation links, links sent to Claude and Discord | yes |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` | The Discord bot (each organization's server and each person's account are set in the app: docs/multi-user.md phase 3) | for Discord |
| `DISCORD_BLOCKED_CHANNELS` | extra channel ids never to read (comma-separated); normally managed in Settings › Connections › Discord instead | optional |
| `CRON_SECRET` | protects the alert check endpoint | for alerts |
| `OPERATOR_EMAILS` | who runs the deployment (comma list): health, Discord registration, Settings › Usage, the built-in schedule (`lib/operator.ts`) | yes (Om's email) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | keys for phone push (a `mailto:` address for the subject). Without them push is off and the Settings status strip says so | for phone push |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | SMTP for "Forgot password?" links, invitations, password-change emails and the Settings test email. `EMAIL_SECURE=true` = TLS from the start (port 465); otherwise STARTTLS is required. | for password reset |
| `OWNER_EMAIL`, `OWNER_NAME` | used only by `scripts/migrate-auth.mjs` (the first user) | for the migration |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (private) for images and files in notes (uploads are switched off) | not used |
| `IG_ACCOUNT_ID`, `IG_PAGE_TOKEN`, `IG_GRAPH_VERSION` | Instagram reel publisher for cutroom (`docs/hosting.md` 9a) | for reels |
| `DELPAT_OS_CLIENT_ID`, `DELPAT_OS_CLIENT_SECRET` | Delpat OS link and project import; hidden while unset (unset on the box) | optional |
| `MCP_ALLOW_URL_TOKEN` | `1` allows putting a Claude chat key in the URL (`/api/mcp/<key>`) instead of a header | leave unset |
| `INVITE_LINK_TO_INVITER` | `0` sends invitation links only by email (the inviter never sees them); unset or `1` also shows the link to whoever invites (docs/auth.md) | default: shown |

**Health check:** `GET /api/admin/health` with `Authorization: Bearer <Claude chat key of an owner or admin>` returns database status, document counts, the Node version, and whether the note converter works.

---

## 2. Tasks and projects

### What a task has
A number (`#12`), title, description, project, mode (type of work), priority P1–P4, status (Not Started, In Progress, Blocked, Done, Dropped), tags, start and due dates, estimate, progress %, checklist, links, blocked reason, dependencies ("waits on #5"), subtasks (one level; see below), a repeat schedule (daily, weekdays, weekly or monthly; the next one is created when it's completed) and archived. Every change is written to the task's **history**, which records who made it: **You**, **You · Discord**, **Claude**, **Claude Code** or **System**.

### Om
- **Laptop:**
  - **Today:** schedule, current time block, overdue, in progress, blocked.
  - **Board:** columns by status, with filters.
  - **Projects:** progress per client.
  - **Task page:** edit everything inline, log progress, checklist, comments, history.
  - **Review** (`/review?view=done|activity|stale|archive|trash`, sidebar and phone Menu): Done, Activity (filter by you, Discord or Claude), Stale (untouched 7+ days, `lib/untouched.ts`), Archive (Restore on each row, with Undo), Trash (deleted tasks and notes: Restore, Delete forever). `/history`, `/hidden` and `/archive` redirect here. The weekly review, the daily routine card and per-person help text were one person's setup and were removed (2026-10-26); their old documents (reviews, ritualLogs) stay in the database, unread.
- **Quick add:** press **N** anywhere. You can type it all in one line:
  - `Send invoice @"Grant Leads" !1 #billing due:fri ~20m mode:admin`
  - That reads as: `@project`, `!1`–`!4` for priority, `#tag`, `due:`, `start:`, `~20m` for the estimate, `mode:`.
  - **Repeat:** `every:day`, `every:weekday`, `every:week`, `every:2w`, `every:month` (also `every:3d`, `every:2m`) make a recurring task; an unknown value stays in the title. Discord `/task` has a `repeat` choice; MCP `add_task` takes `recurrence`. The New task form (Shift+Enter) and the task page have a Repeats select. Recurring tasks show a small repeat icon on rows, board cards and Today rows (`lib/recurrence-options.ts` holds the choices).
- **Completing a recurring task** creates its next occurrence automatically (its subtasks come back as new open ones).
- **Subtasks** (docs/subtasks.md, #183): the task page has a Subtasks section (add a title and press Enter, tick one done, open it, × takes it out). A parent shows "3/8" on rows and board cards and its progress is the average of its subtasks (Done counts 100, Dropped is left out); a subtask shows "in <parent>" and its page says "Subtask of #N". One level only. A subtask is in its parent's project and moves with it. Completing a parent with open subtasks asks "Close the N open subtasks too?" (Close them / Leave them open). Deleting a parent takes its subtasks to the trash; restoring it brings them back.
- **Reopening a done task** restores its earlier progress. It no longer stays at 100%.

### Delpat OS import (2026-10)
- **Om:** Settings › Connections › **Delpat OS** › Link (once per person; sign in at Delpat OS and allow). Then New project › **From Delpat OS**: search your Delpat OS projects and press Import. Name, client, status and a description (focus and phases) are filled; it is Shared unless you pick Private. An imported project shows "Already in Work OS" next time. Hidden until `DELPAT_OS_CLIENT_SECRET` is set on the server.
- **Claude Code:** `lib/delpat-os.ts` (everything), `docs/auth.md` "Linking Delpat OS" (security design), `ProjectDoc.delpatOsId` (unique per organization). Env in `docs/hosting.md`. Tests `delpat-os` and `delpat-os-off`.

### Claude
`list_tasks`, `get_task`, `add_task`, `update_task`, `log_progress`, `complete_task`, `add_comment`, `update_checklist`, `list_projects`, `add_project`, `update_project`, `daily_summary`, `recent_activity`.
- **Subtasks:** `add_task` (and `apply_changes` `create_task`) take `subtasks: [{title, …}]` to make a parent and its subtasks in one call, and `parent` (a ref, or "$name" in a batch); `update_task` `parent` moves a task under another (`null` takes it out); `get_task` returns `parent` or `subtasks` (status, progress, assignees) and `subtaskProgress`; `list_tasks` takes `parent`; task answers carry `parent` ("#12 Title") or `subtasks` ("3 of 8 done"). `complete_task` on a parent leaves open subtasks open and lists them (`openSubtasks`). The tool text says when to use a subtask (a deliverable someone tracks on its own) and when a checklist item (a step the same person does inside the task); `add_task` and the server instructions say "for 2 or more writes, use apply_changes".
- **`daily_summary`** is the one call for a morning brief: overdue, due today, in progress, blocked and waiting, the next 7 days, everything completed or changed since the last workday and who did it, and per-project counts.
- **Dates** accept `today`, `tomorrow`, weekday names, `+3d`, `+2w` or `YYYY-MM-DD`.
- **Assignees** (phase 4, several per task since #165): `add_task`, `update_task` and the batch task ops take `assignees` (the whole list: 'me', emails, names or user ids; [] or null clears) and still `assignee` (one; replaces the list), only on tasks in shared projects (and only people on the list of a project shared with chosen people: every assignee must pass `canBeAssigned`); each newly added person gets the "Assigned to you" alert, someone taken off stops getting the task's alerts. `list_tasks` `assignee` matches any of them; task answers show `assignee` ("me, Bea") and `assignees` (the list). In the app: the task page's Assigned field (desktop) and row (phone) open a tick list (`components/assignee-picker.tsx`, one save for the whole list); task rows (Tasks, board, Today, project) show up to three initials (`AssigneeDots`). Stored as `assigneeIds: string[]`; tasks from before carry one `assigneeId`, which every read and query still takes (`lib/assignees.ts`: `assigneesOf`, `assignedTo`, `unassigned`, `unassignableFilter` with `unassignPull` for a project cascade, which takes off only the people who lose access) and which a task's next change moves over. `node scripts/migrate-assignees.mjs --db <name>` (dry run, counts only) then `--apply` moves every task and trash copy at once; after it has run on the box, the old-field paths can go.
- **Shared and private projects** (UI): the New project dialog and sheet have a Shared / Private choice (default Shared; help line under it). Project › Info › "Who sees it" switches it (`updateProjectAction` → `updateProject`, which cascades to tasks, notes, Claude items, history and trash, and drops other assignees when made private). Only the project's owner may switch (data layer refuses others; the choice is disabled for them). Under Shared, **Everyone** (default) or **Choose people** (tick members, Save; the owner is always on the list): `visibility: 'members'` + `sharedWith`, cascaded the same way; a "Has access" line and a "N people" badge show who sees it. The rule lives in `lib/visibility.ts` (see docs/multi-user.md "As built: sharing a project with chosen people"); assignees must be on the list (`canBeAssigned`, lib/assignees.ts), and taking people off asks first and ends their assignments, Claude tasks and waits like Shared → Private. Shared → Private asks first when someone else is assigned or has commented (`projectSharingImpact`, `projectSharingImpactAction`): they lose access, their assignments are removed, their queued or running Claude tasks in it end (`endForeignClaude` in dispatcher.ts: queued mark cleared, running one stopped with a stop job) and Claude items waiting on them stop waiting. A "Private" badge (`components/private-badge.tsx`, lock icon, `data-private-badge`) shows on private projects in the projects list, project header, task rows and pages, start-Claude picker, Tasks/Notes pickers and filters; shared ones show nothing. `scripts/migrate-ownership.mjs` now makes old projects private (owner: the first owner), so the owner shares them one by one. Tested by `tests/e2e/sharing.mjs`.

### Claude Code
- **Data layer:** `lib/data/tasks.ts` (create, update, history, recurrence, queries) and `lib/data/projects.ts`. Pages, server actions (`app/actions.ts`), MCP and Discord all go through it.
- **Types:** `lib/types.ts` (zod schemas). Stored document shapes and indexes: `lib/db.ts`.
- **History:** entries in `activity` are written by `logActivity()`; display text comes from `lib/activity-text.ts`.
- **Subtasks:** the "Subtasks" block in `lib/data/tasks.ts` (`placeUnder`, `parentFor`, `rollUp`, `moveSubtasks`, `listSubtasks`, `createTaskWithSubtasks`); trash and restore (`trashOne`, `restoreOne`, `withParent` on TrashDoc); UI in `components/subtasks.tsx` (chip, "in" line, the close question, the task page section). Stored fields and rules: docs/subtasks.md "As built". Tested by `tests/e2e/subtasks.mjs`.

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
  - **Needs (ask one person one thing):** `ask`, `needs`, `withdraw_need`. An agent that needs ONE person to decide, approve, do or chase something calls `ask` instead of writing "waits on Om" in text. **No tool, key or OAuth client answers a Need**: only the addressed person does, in the app (Today's "Needs you" block on the laptop and the phone, or the project's Needs tab). The asker reads the answer with `needs`. `ask` refuses a `to` who cannot read the project; at most 5 open Needs from one asker to one person; a second open Need of the same kind on the same task replaces the first. The task then shows "Needs <name>: <ask>" instead of its percent, and is never "stalled". The asker's word is set by the server, never by an argument: `chat` only for a claude.ai app that signed in through OAuth (its key id starts `oauth_`; it may run unattended), `agent` for every key, including a static Claude chat key. At most 10 Needs created from one asker to one person in an hour (any status), and a replacement of a Need alerted under 10 minutes ago sends no second alert. `withdraw_need` takes back only a Need of the same word and, where recorded, the same session and key; a person's own Needs and review Needs are never withdrawn by an agent.
  - **Results and review (slice 5):** `hand_in(task, changed, checked, rating, where, left, kind)` is how an agent says what it did (links and lines; no files). Each task has an optional `resultKind` (code, data, client, check, report; `result_kind` on add_task / update_task). **Decision 4 sits in the data layer** (`updateTask` in `lib/data/tasks.ts`, which every path to Done ends in: update_task, log_progress, apply_changes ops, complete_task, hand_in, the dispatcher's agent): an agent closing code, data or client work does not close it; a `review` Need (Accept / Send back with a line / Accept and file what is left) goes to the task's owner and the task stays open. check, report and no kind finish by themselves, and so does a person. An agent cannot loosen code/data/client to get past the gate. Send back puts the owner's line first in `get_task` and in `start_work`'s brief of that task (`sentBack`) and re-queues a dispatched task. The outcome is kept on the task (`review.outcome`: accepted_first_time / accepted_after_send_back, `review.sentBack` count). For a dispatched task the review alert replaces `claude_finished`. Data: `lib/data/results.ts`, `createReviewNeed` / `applyReview` in `lib/data/needs.ts`.

### Claude Code
- **Endpoint:** `app/api/mcp/[[...key]]/route.ts`. Stateless Streamable HTTP. `Authorization: Bearer` takes an OAuth access token (`wosat_…`, `lib/oauth.ts`) or an API key (`wos_…`, also `X-API-Key`); no or bad credentials get 401 with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`. An OAuth client counts as a Claude chat key only when all its registered redirect addresses are claude.ai's callback; any other client gets the Claude Code rules.
- **Tool handlers:** `lib/mcp/server.ts`.
- **Tool titles, descriptions and server instructions:** `lib/mcp/docs.ts`. This one file feeds both MCP and Settings › Connections, so edit descriptions there.
- **Adding a tool:** add its name to `ToolName` and an entry in `TOOLS` (docs.ts), register it with `tool(...)` in server.ts, and add it to the tool groups in `app/(app)/settings/data.ts`.
- **Smoke test:** `node scripts/test-mcp.mjs <url>/api/mcp <Claude chat key> [--write]`.
- **Needs (slice 4 of docs/flows/plan-1-3.md):** data `lib/data/needs.ts` (`askNeed`, `answerNeed`, `withdrawNeed`, `listNeeds`; collection `needs`, stamped with its project's placement and moved by `setProjectPlacement`, so `takeOffLists` and a project made private take Needs along); tools in `lib/mcp/server.ts` (end of `createMcpServer`); `answer_need` is also in policy.ts BLOCKED so adding such a tool cannot open it to Claude Code keys. The only way to answer is the server action `answerNeedAction` (`app/(app)/needs/actions.ts`, session cookie, the addressed person only; not found, not readable and not yours read the same). Each Need records `createdAt`, `answeredAt` and `waitedMs` from day one. The task's open Need is a denormalised `need` mark on the task (`syncTaskNeed`; rows read it through `NeedChip`, `components/need-chip.tsx`); `lib/alerts.ts` skips such tasks for "stalled". UI: `components/needs.tsx` (`NeedsYou` on Today, `NeedsTab` on the project page). Wired into slice 1: `start_work` lists answered Needs the caller asked (once; matched by session, and always by the asking key) then the open ones addressed to the caller; `lib/mcp/for-you.ts` has a `needs` source ("your Need #N was answered", "N Need(s) for you": ids and counts only); State's Next lines get a read-side `waitsOn` from open Needs on their task (`withNeedWaits`). A task that moves (project or placement) restamps its Needs and withdraws those whose addressee cannot read it (`restampTaskNeeds`); a person taken off a list or removed from the organization has their open Needs withdrawn (`withdrawUnreadableNeeds`). The 5-open limit holds under a race because the `need:<org>` counter write inside the transaction is the lock. Tests: `tests/e2e/flow-n1.mjs`, `flow-n2.mjs`, `flow-n3.mjs` (wiring), `flow-n4.mjs` (security review), `flow-r1.mjs` (results and review), and the Needs and hand_in entries in `leak-audit.mjs`.
  - **App-only Needs and the Discord button (slice 6):** a Need is app-only when the asker said so (`app_only`) or when its ask, example or an option label or meaning contains one of `SENSITIVE_NEED_WORDS` in `lib/data/needs.ts` (production, deploy, payment, refund, invoice, money, password, credential, secret, token, key; whole words, with a trailing s/ed/ing/ment) or a ₹ / $ amount. That list is the only place; `askNeed` applies it whatever the asker declared. App-only Needs and every `review` Need get no buttons in the DM (only the link), a crafted press is refused with the link (`lib/discord/need-buttons.ts`: Discord may steer, never release). The press also needs the addressee's linked account, an organization with a Discord server, and the Need still readable through the addressee's own door; withdrawn and replaced Needs are reported as such. The team digest shows a Need's ask only for a Need the project's owner asked in person (actor kind user), never app-only. `plainAlertText` escapes Discord markdown after dropping mentions; button labels use `neutralAlertText` (plain text).

### Claude Code keys
- **Om:** `/claude?tab=setup` → **Keys** (Claude area; `/connect?tab=code` redirects there): name a key, **Create**, copy it (shown once) or the ready `claude mcp add --transport http work-os <url> --header "Authorization: Bearer <key>"` command. The list shows prefix, created and last used; **Rotate** (old key dies, new one shown) and **Revoke**. Changes made with a key show as **Claude Code** in history (filter "By Claude Code"), with the `X-Work-OS-Repo` / `X-Work-OS-Session` headers shown small next to them if the session sends them.
- **What a key can do:** everything the claude.ai connector can (projects, tasks, notes, trash, Discord reads; the channel blocklist still applies). **Claude Code keys work on `/api/mcp` only**; Claude chat keys also on the other API routes (admin needs an owner or admin). Keys are Better Auth API keys owned by a user in an organization (`docs/auth.md`).
- **Rules** (`lib/mcp/policy.ts`, a no-op for Claude chat keys): (except the mail runaway guards: 200 mail deletes+moves and 100 sends per hour per person, every caller); no permanent deletion/admin tools or ops; 300 tool calls per rolling hour per key; 10 trashes per 10 minutes; an `apply_changes` that trashes > 10 items or changes > 50 tasks needs a dry run first, whose `confirm` token (HMAC of the ops + 10-minute expiry, `BETTER_AUTH_SECRET`) the real call must pass. When a key changes title/priority/due/project of, or trashes, a task it didn't create, Om gets one inbox notice per call (Settings → Notifications → "Claude Code changes", default on).
- **Code:** `lib/api-keys.ts` (Better Auth apiKey plugin, `wos_` + 48 characters, hashed; `metadata: {agent, orgId}`), `lib/caller.ts` `verifyKey`, `lib/mcp/policy.ts` (counters in `policyEvents`, TTL 2h; `Caller` = `{agent, keyId, keyName, userId, orgId}`, `callerScope`), `lib/request-context.ts` (session/repo headers → `logActivity`), UI `app/(app)/claude/keys.tsx` + `setup-actions.ts`.
- **Turbo mode (clone, link, start):** Start Claude / a dispatched task on a project whose repo is not on the PC makes the worker clone it into its projects folder, link it and start. Spec, guards and flow: `docs/launcher.md` "Turbo mode". Worker side `worker/clone.mjs` (URL rules, destination, git args, timeout; unit tests `worker/test/clone.test.mjs`); server `lib/data/turbo.ts` (who may, `turboStart`, `turboInfo`, dispatcher plan), jobs carry `clone: { repo }`, sessions `cloning`/`repo`, devices report `worker.allowClone`/`projectsDir`; code locations keep a non-GitHub `host`. UI: start sheet, Info › Code lines (`folders.tsx` TurboLines). e2e `tests/e2e/turbo.mjs`.
- **Project code locations:** projects have `code: [{remote, subdir?, branch?} | {path}]` (project page → Code locations, or `add_project` / `update_project` / batch ops). Remotes are stored as lowercase `owner/name`, credentials stripped. `get_project` with `remote`/`subdir`/`branch`/`path` instead of a name picks the most specific match (remote+subdir+branch > remote+subdir or +branch > remote > longest path), else returns `unmatched` with candidates. A branch ending in `*` matches by prefix (`wt/ana*`). Matcher: `lib/data/code-locations.ts` (pure functions).

### Mail (Mailloom)
- **Om:** Settings › Connections › **Mail** › **Connect Mailloom**: Mailloom opens, you pick the mailbox, tick what Work OS may do (read is required; organise and send can be unticked), enter the mailbox password and press Allow. Back in Work OS the row shows the mailbox, the key's prefix and what was granted. **Connect again** replaces the key, **Test** asks Mailloom who the key is, **Disconnect** deletes it here. Only keys Work OS minted (Connect) are revoked at Mailloom (on Disconnect, replace and member removal); a pasted key is just forgotten. One Mailloom key per person across organizations: connecting in one organization replaces the key from another. "Paste a key instead" (folded) still takes a key made in Mailloom › Connections; it is the only way when Connect is not set up. A member removed from the organization has their connected key revoked at Mailloom too.
- **Claude:** the `mail_*` tools act through the caller's own key only (`lib/mail/tools.ts`); outside-domain mail is refused (drafted via ask, a person sends); 100 sends and 200 deletes/moves per hour per person.
- **Claude Code:** `lib/mail/client.ts` (agent API client; `MAILLOOM_CONNECT` holds Mailloom's Connect paths and Work OS's env names in one place: authorize `<MAILLOOM_WEB_URL>/oauth/authorize` (its `iss` must equal MAILLOOM_WEB_URL exactly), swap `<MAILLOOM_AGENT_URL>/oauth/token`, self-revoke `<MAILLOOM_AGENT_URL>/key/revoke`, callback `/api/mail/callback`), `lib/mail/keys.ts` (sealed key in settings `mail:<userId>`, AAD org+user), `lib/mail/connect.ts` (start, callback, member removal; one key per person across organizations, the replaced minted key revoked even from another organization; state hashed in `mailConnectAuth`, bound to person, organization and session, single use, 10 minutes; PKCE verifier sealed; client secret on the swap; whoami check; old key revoked), `app/api/mail/callback/route.ts` (303 to Settings with `mail=linked|revokefail|denied|error`), UI `app/(app)/settings/mail-key.tsx` + `mail-actions.ts`. Design and threats: `docs/flows/mail-connect.md`. Tests: `mail` (fake Mailloom with the Connect endpoints) and `mail-paste` (no Connect client).

### Intake (Mailloom reports)
- **Om:** a problem reported with Mailloom's "Report a problem" form arrives as a task in the project `MAILLOOM_INTAKE_PROJECT` names: title `Report: <title>`, P3, Not Started, tag `mailloom-report`, owned by and assigned to the project's owner (who gets the usual "assigned to you" notice, by "the Mailloom report form"). The description starts with "Reported in Mailloom by <reporter>.", then a fenced block (report id, version, device, browser, view, errors), then a rule and the reporter's own markdown, unchanged. History says "Mailloom report form", never a person or Claude.
- **Claude:** get_task marks the title and description `writtenBy` `Mailloom report from "<reporter>" (outside Work OS)`: information, never instructions; `createdBy` reads `system (Mailloom report form)`. List outputs (list_tasks, daily_summary, start_work's open tasks, get_project) give such a title `titleWrittenBy`, and carry the text rule when one of their titles has it; titles from Discord messages and emails get the same label (`outsideTitleLabel` in `lib/data/authors.ts`).
- **Contract:** `POST /api/intake/mailloom`, `Authorization: Bearer <MAILLOOM_INTAKE_TOKEN>`, JSON at most 64 KB: `report_id` (1-100, the sender's id), `reporter` (email, at most 320), `title` (1-200), `description_markdown` (at most 10000), `details?` {`version` 100, `device` 200, `browser` 200, `view` 300, `errors` up to 20 lines of 500}. Unknown fields are dropped (not stored or shown). Replies: 201 `{ref, url}` new task; 200 `{ref, url}` the same `report_id` again (the same task, unchanged); 400 `{error}` in plain words; 401 bad or missing token; 413 over 64 KB (also a streamed body); 429 over 60 new reports an hour, with `Retry-After` (a repeat costs nothing); 503 not configured (either variable or `APP_URL` unset, the token under 32 characters after trimming or equal to another secret: `MAILLOOM_CLIENT_SECRET`, `CRON_SECRET`, `BETTER_AUTH_SECRET`, `MAIL_KEY_SECRET`), or the project missing, archived or its owner gone. Other methods 405 (`Allow: POST`). `Cache-Control: no-store`. `url` = `APP_URL/tasks/<ref>` (never from the request's Host).
- **Notices:** `POST /api/intake/mailloom/notice`, the same token, JSON `{text}` (1-1900 characters, not blank; body at most 4 KB): the Work OS bot posts the text to the one channel `MAILLOOM_NOTICE_CHANNEL` names (never one from the request), with `allowed_mentions: {parse: []}` and embeds suppressed; `@everyone` / `@here` also get a zero-width space after the @. Replies: 204 posted; 400 bad input; 401; 413; 429 over 20 an hour (`Retry-After`, a counter apart from the reports'); 502 `{error}` when Discord refuses, in plain words (e.g. the bot lacks View Channel or Send Messages there); 503 not configured (the token, the Discord bot or the channel id missing). Logs `[intake] mailloom notice <status>` only. Used by Mailloom's nightly updater.
- **Claude Code:** `lib/intake.ts` (config, constant-time token check: sha256 of both then `timingSafeEqual`; zod schema; description builder: the fence is longer than any backtick run inside, and our parts come before the reporter's markdown so nothing in it can swallow them; `takeReport`), `app/api/intake/mailloom/route.ts` (size cap before parsing, replies; logs only `[intake] mailloom <status> #<ref>`, never the token, body or reporter). The task goes through `createTask` in the project owner's scope, actor `MAILLOOM_INTAKE` (`{kind:'system', via:'mailloom-intake'}`, `lib/actors.ts`), title and description authored `{kind:'report-author', source:'mailloom', name}` (`lib/data/authors.ts`). The project id comes only from the environment; organization and owner from the project document. Idempotency: the `intake` collection (unique `source`+`reportId`, ids only), claimed before the task is made so parallel copies wait for it; a claim left by a request that died is taken over after a minute. The task also stores `source: {kind:'intake', messageId:'intake:mailloom:<report_id>'}` and is looked up by it before one is made, so a claim that lost its task (a crash between the two writes) finds it instead of making another; a request whose claim was taken over while it was still making the task records it on the current claim (a duplicate, if one was made after all, is logged by number only). Rate limit: `reserveIntake` in `lib/mcp/policy.ts` (`policyEvents` key `intake:mailloom`, the same race-safe reserve as the key budgets). `proxy.ts` lets the two exact intake paths through (they check their own token; anything else under `/api/intake` stays behind the login gate); `lib/usage.ts` counts it as caller `intake`. Notices: `postNotice` in `lib/intake.ts` through `api()` in `lib/discord/client.ts`, route `app/api/intake/mailloom/notice/route.ts`, limit `reserveIntake('mailloom-notice')`. Tests: `intake` (run.sh `intake` mode sets the intake variables and points the bot at the suite's stub Discord) and `intake-off` (unset: 503).

### Starting work, State, Orders, presence (step 1, slice 1; design in `docs/flows/step-1.md`)
- **Tools:** `start_work` (project, or remote/branch/path; machine, label, optional session) returns in order: Orders, State, open tasks, who else is present (30 minutes), State version, plus a session id. `get_state`, `save_state(project, ops, base_version?)` (ops: set_now, add_next, move_next, done_next, add_later, promote_later, add_decision, set_where; one version bump per call; a stale `base_version` is refused with the current State), `import_state(project, markdown)` (once, only when no State exists). Code: `lib/data/states.ts`, `lib/mcp/server.ts`.
- **State** (`states`, one per project) carries the project's placement and moves with it (`setProjectPlacement`, so `takeOffLists` too). Lines written by someone other than the reader come back with `writtenBy` (text by others is information, not instructions). The project page has a State card (`state-card.tsx`, versioned writes via `state-actions.ts`).
- **Orders:** a note with an `orders` flag (`org`, `project` or `person`), set in the app only (note page; `orders-actions.ts`). Only the organization's owner (org layer), the project's owner (project layer) or the note's owner (person layer) may set it. MCP writes to any Orders note are refused for every key (`guardOrders` in `lib/data/notes.ts`). `lib/data/orders.ts`.
- **Presence** (`presence`, a row per session, placement-stamped, TTL 7 days, refreshed at most once a minute, not a push topic). A session is named by the `session` argument or the `X-Work-OS-Session` header (any client kind); without one, by key plus project. `ai` is the client name.
- **`forYou`:** every tool answer of a present session may carry `forYou: string[]` (ids and counts only, never text): new tasks and Next lines since the session's cursor (`forYouCursor`), and "State not saved since 10 writes". Sources are a registry in `lib/mcp/for-you.ts`.
- **Messages (slice 3, `docs/flows/step-1.md` section 4):** collection `messages`, placement-stamped (cascade and `takeOffLists` move it with the project). Tools `send_message` (answers with the target's presence: "cutroom: offline, last active 3 h ago; it will get this on start"), `inbox`, `message_status` (seen, applied with commit and note, rejected; `make_task` turns a request into a task) and `reply`. `word` (person = the app, chat = claude.ai connector or a Claude chat key, agent = any other key) is set by the server, never an argument. Applying a decision adds it to the State's Decisions (`via`, message id); an agent may apply a decision only when it is its own person's word, otherwise a person applies it in the app. `start_work` lists the inbox (unread first) after the State. A `forYou` source names new messages by id. App: Inbox tab on the project page (`inbox-tab.tsx`, `inbox-actions.ts`). Code: `lib/data/messages.ts`.
- **Review fixes to slice 1:** the `forYou` cursor trails the call start by 2 s and the presence row keeps the last 20 named ids (items carry the `src` session or key that made them, and a session is not told about its own); person Orders store `ordersBy` and are served only to the person who set them (the flag is dropped when a placement change moves the note to another owner); the Orders switch carries the page's `updatedAt` and refuses a stale write; State ops are logged (last 200, with user, key and session), `archive_decision` (owner only), 30 decisions an hour per key; presence rows are keyed by session and project. `scripts/migrate-orders.mjs --db <name> [--apply]` marks each organization's "Claude Code boilerplate" note as its organization Orders.
- **Tests:** `tests/e2e/flow-s1.mjs`, `flow-s2.mjs`, `flow-h1.mjs`, plus entries in `leak-audit.mjs`.
- **The roster (slice 7; plan in `docs/flows/plan-1-3.md`):** presence grows into workers. `start_work` also takes `model`, `account` (a label, never a key or email), `parent` (the orchestrator's session id, for a builder) and `slot` (a builder's name), and stores the `branch` it already took; `set_doing(task)` records the task a session is on. `machine` becomes the device id when the name (or id) is one of the person's own computers (`resolveMachine` in `lib/data/presence.ts`; the device's name is kept as `machineName`), else stays the reported name. A worker's state is **computed on every read** in `lib/data/roster.ts` (`workerState`): working (seen in 10 minutes), waiting (an open Need, read only through `lib/data/roster-needs.ts`, which answers "nobody" while the `needs` collection does not exist), idle (10 to 30 minutes; shows how many unblocked Next lines its project has), gone (30 minutes and, where the computer's daemon list is fresh, its process not running; its task shows "unheld"). `couldBeRunning(scope)` is exported for the digest: active projects the caller can read whose State has unblocked Next lines (no `waitsOn`, not pointing at a Done, Dropped or Blocked task) and no live worker.
- **Heavy slots** (`slot(machine?, 'heavy', acquire | release, wait_seconds?)`, `lib/data/slots.ts`, collection `slots`, one document per machine, org-scoped door rule): at most 2 holders per machine across every session on it (a `cap` field on the document overrides), each a 30-minute lease that a repeated acquire renews. Acquire is a filter-guarded single-document `$push` (`holds.<cap-1>` must not exist), so concurrent requests never exceed the cap; the door forbids pipeline updates, hence no aggregation update. A machine name that is not a device is kept per person, so two people's "laptop" are two machines.
- **Roster tests:** `tests/e2e/flow-w1.mjs` (roster, states, builders under orchestrators, could-be-running, the Workers tab at 390 and 1280), `flow-w3.mjs` (slots), entries in `leak-audit.mjs`.

---

## 4. Batch changes, full project view, trash

### Om
- **Search:** the search icon in phone headers, the sidebar Search button, `/` and `Ctrl+K` (desktop) open one search over tasks (title, `#12`), projects (name, client), notes (title, text) and Claude items (title, `C12`), 6 per group (`lib/data/search.ts`, server action `app/(app)/search-action.ts`, `components/global-search.tsx`). Up/Down/Enter on desktop. The Tasks page keeps its own filter box.
- **Delete a task:** task page → Delete; on the phone, task → ⋯ → Delete. It goes to the **trash for 30 days**, together with its history and note, and the confirmation has **Undo**.
- **Trash:** Review → **Trash** (on the phone, Menu → Review → Trash) lets you Restore or Delete forever. Deleted notes are listed there too. Opening a deleted task's link shows "This task is in the trash" with a Restore button.
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
- **App side:** `components/trash-controls.tsx`, `components/comment-entry.tsx`, and the Trash view in `app/(app)/review/views.tsx`.

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
- **Delete:** a page goes to the trash for 30 days, with Undo. Deleting a page also deletes its sub-pages. Review → Trash lists deleted notes (sub-pages fold into the page they went with) with Restore and Delete forever.
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
  - **Needs jsdom 26:** an npm override in package.json pins it. jsdom 29 uses ES-module `require()`, which broke the build on Vercel; keep the pin until it is re-tested.
  - **Needs `serverExternalPackages`** for BlockNote in `next.config.ts`.
- **Data:** `lib/data/notes.ts`.
  - **One live note per task:** a partial unique index on `{taskId, deletedAt}`.
  - **Soft delete:** `deletedAt`; deletion cascades to sub-pages. `listDeletedNotes` (Review › Trash) purges notes older than 30 days first, like the task trash; `purgeNote` deletes one for good with its sub-pages.
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
- **Posting:** the bot posts in a channel only for the team digest (`lib/team-digest.ts`: one message a day to the channel an owner or the operator sets in Settings › Server › Discord; the channel must belong to the organization's server, checked when it is saved and again before each send; project names, tasks, Now and who it waits on go through `plainAlertText`, mentions off). It never reacts or changes anything. Its other output is replies that only the asker can see, plus DMs (see section 7), where a Need arrives with its options as buttons.

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
| Daily digest | Once a day at your own hour (Settings › Alerts, default 09:00): what agents finished, due and overdue, gone quiet, what moved yesterday. One message through your channels |
| Due today | 09:00, all tasks due that day (with the digest on: inside it) |
| Overdue | The morning after the due date, then every 2 days (with the digest on: inside it) |
| Stalled | In Progress with no activity for 2 workdays (with the digest on: inside it) |
| Never started | P1 still Not Started 24 hours after creation |
| Unblocked | Right away, when the last task it waited on is closed |
| Needs you | Right away, when someone or an agent asks you one thing (a Need): one alert per Need, labelled with who asked. The push and the Discord link open Today at that Need (`/today#need-<number>`). Switch: Settings › Alerts › Needs you |

- **Where an alert goes:** three channels. Each alert type and each channel has a switch in Settings (section 9).
  - **In-app inbox:** always on. Bell with an unread badge on the phone's Today header (the laptop sidebar has a Notifications link, no badge); the **Notifications** screen (`/notifications`, also Menu → Inbox on the phone, Inbox in the laptop sidebar) lists them newest first, and opening it marks all read. Kept 60 days.
  - **Phone push:** a real notification on every device that turned it on in Settings. Tapping it opens the task (or the inbox when several arrived together). **iPhone needs the app added to the Home Screen and iOS 16.4 or later**; it won't offer push in a normal Safari tab.
  - **Discord DM:** as before.
  - **Send test** (Settings → Notifications) sends one through every enabled channel and shows what reached where.
- **The daily digest (flow B4, plan-1-3 slice 2):** the person's `digestHour` (profile, default 9) and the alert switch `digest` (on by default; `scripts/migrate-digest.mjs --db <name> [--apply]` saves it on for whoever has Due today on, off for whoever turned it off; idempotent). Sections in order: **What agents finished** (`claude_finished` / `claude_stopped` rows of `alertQueue` created since the last digest, already sent as alerts), **Due and overdue**, **Gone quiet** (In Progress, 2 workdays untouched), **Moved yesterday** (one line per project from `activity`, previous working day up to today, only projects the person can read). An empty digest is claimed and not sent. Needs and "idle with Next work" join in slice 6.
  - **What it absorbs:** while the digest is on and today's has not gone out, due today, overdue and stalled wait for it (also before its hour) and go into it; their log keys are claimed with it. Once it has gone out, a task that becomes due, overdue or quiet still alerts on its own on the next 15-minute run. Everything else (`due_tomorrow`, `never_started`, `unblocked`, `assigned`, `claude_*`) is unchanged. Switch the digest off and the morning alerts work as before.
  - **Claimed once a day** by the `alertLog` key `digest:<date>:<userId>` (the person is in the key because alertLog ids are shared by everyone; sentAt = the run's time, so "since the last digest" shares the queue rows' clock; `empty: true` on a day with nothing). The first digest a person gets starts with one line saying the morning alerts are now this digest. Channels: inbox (one row, opens Today), push (opens Today), Discord DM if linked; there is no mail channel for alerts yet.
- **Rules:** quiet hours 23:00–08:00 IST (anything due then waits until morning), one combined DM per check, and each alert sent only once.
- **Status:** Settings › Alerts (and the status strip at the top of Settings) shows when the last check ran and what it did.
- **Setup still to do:**
  1. Add `CRON_SECRET` to `/etc/work-os/env` on the server and restart `work-os`. `work-os-alerts.timer` (see `docs/hosting.md`) then calls the check every 15 minutes; check it with `systemctl list-timers 'work-os*'` and `journalctl -u work-os-alerts`.
  3. For phone push, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` to `/etc/work-os/env` and restart, then turn on "Notifications on this device" in Settings on each phone.
  4. If DMs fail with a 403: Discord → Delpat server → Privacy Settings → allow direct messages.

### Claude
Nothing to call; alerts run on their own. Claude's own changes trigger them like anyone's: when Claude completes a blocking task, the unblocked alert goes out (to the waiting task's owner, or each of its assignees).

**Per person (phase 2):**
- Every alert has recipients: the assignees of a shared task, else its owner (`recipientsOf` in lib/data/tasks.ts). Assigning someone sends them "Assigned to you" at once (phase 4); an assignee's alert log keys carry their user id, so a task that changes hands alerts its new recipient.
- The cron runs once per member, each with their own settings (`notify:<userId>`), inbox and push devices.
- The Discord DM goes only to the Discord-linked person.

### Claude Code
- **Logic:** `lib/alerts.ts`. The thresholds are in `ALERT_RULES`.
  - `alertLog`: one record per alert sent, so each goes out once.
  - `alertQueue`: event alerts waiting to be sent (unblocked, assigned, Claude finished or stopped, and `need`: a row per Need with `needId`; dropped at send time if the Need was answered, withdrawn or replaced meanwhile).
  - The digest: `buildDigest` in `lib/alerts.ts`; `?at=` on the cron drives its tests (`tests/e2e/flow-b4.mjs`).
- **Queueing:** `queueUnblocked()` is called from `updateTask` **inside** the same transaction as the write, so a batch that rolls back never queues an alert.
- **Sending soon after a write:** `flushQueuedAlerts()` runs via `after()` in the MCP route, the Discord interactions route and the app's server actions.
- **Exactly once, even when runs overlap:** a run claims each alert before delivering it (queue entry: `sentAt: null` → now, conditional update; scheduled alert: insert into `alertLog`, duplicate key = another run has it). Several flushes after a batch plus the cron can no longer send the same alert twice. A claimed alert stays sent even if a channel then fails.
- **Endpoint:** `app/api/cron/alerts/route.ts`. Without the `CRON_SECRET` header it returns 401 (503 if the secret isn't set at all).
  - `?dry=1` previews without sending.
  - `?at=<ISO>` simulates a different time (400 for an invalid date; clamped to a week either side of now). It is ignored in production, except in the e2e runner's production build: there `CRON_ALLOW_AT=1` honours it only when `MONGODB_DB` starts with `workos_e2e` (lib/cron-at.ts), with a loud warning at boot (`instrumentation.ts`), and only then do alertLog stamps carry the simulated time (elsewhere stamps are always the real clock).
- **Discord:** DMs are sent by the same bot, which opens a DM channel with the owner.
- **Delivery:** `lib/notify.ts`. `runAlerts` (alerts.ts) drops alert types switched off, then writes the inbox, sends push, then DMs; a failing channel doesn't block the others.
  - **Settings storage:** `settings` doc `_id: 'notify'` (`channels.push`, `channels.discord`, `kinds.*`; everything defaults on). Alert types and their labels: `ALERT_KINDS`.
  - **Collections:** `notifications` (inbox) and `pushSubs` (one per device, keyed by push endpoint; dead ones are deleted when the push service answers 404/410). Both in `lib/db.ts`.
  - **Push:** the `web-push` package; VAPID keys from env. `public/sw.js` handles `push` and `notificationclick`. Push needs a production build (the service worker is production only).
  - **UI:** `app/(app)/notifications/`, `components/mobile/bell.tsx` (unread count comes from `useApp()` in `components/app-context.tsx`).

### Tasks for Claude (dispatcher)

**Om:** on a task (page, row menu) choose **Give to Claude**; if the project has several linked folders you pick one. Claude › Setup › Tasks for Claude has the on/off switch (off by default), how many sessions at once (default 2) and the note every session reads first. When a computer has room, its worker starts a Claude Code session on the oldest task you gave; the **Claude's tasks** section on Claude › Now shows working, queued and recently finished or stopped. You get one alert when it finishes ("Claude finished #12") or stops ("Claude stopped on #12: reason") and one if it goes quiet 20 minutes ("may be stuck"). **Take back** works any time (a running one stops its session). Only you can give or take back; Claude, Discord and batch changes cannot.

**VS Code and reopen after a restart:** Sessions on the Claude page (and the project's) have **Open in VS Code** (the PC runs `Code.exe <folder>` then the `vscode://anthropic.claude-code/open?session=<id>` link; VS Code asks Om once to allow it). After a crash or restart the worker offers "N sessions were open before your PC restarted" with **Reopen all** / **Dismiss**; each reopens where it was made (VS Code or terminal), never without the tap. Details, trust checks and what was not verified: `docs/launcher.md` "VS Code and Reopen after a restart"; code `worker/vscode.mjs`, `worker/openset.mjs`, `locate()` in `worker/core.mjs`, server `lib/data/launcher.ts` (`openSessionInVscode`, `reopenAll`, `reopenPrompts`), UI `app/(app)/claude/reopen-banner.tsx`; e2e `tests/e2e/vscode-reopen.mjs`.

**Claude Code:** design, rules and what differs from the plan are in `docs/dispatcher.md` ("As built"). All logic is `lib/data/dispatcher.ts`; `claude` on a task is written only by `app/(app)/claude/dispatcher-actions.ts` (session cookie) and the dispatcher; `updateTask`/`createTask` never touch it. The claim runs in `GET /api/worker/jobs` (`dispatchFor`), outcomes are settled on worker status, task changes and the alerts cron (`reconcileDispatched`). Test with a throwaway mongod replica set and a fake device key (never the real database).

---

### Claude Code hooks (slice 1b of docs/flows/plan-1-3.md)
- **What:** `worker/hook.mjs`, shipped in the worker bundle, is a SessionStart hook (matcher `startup|resume|clear|compact`) and a Stop hook for Claude Code. SessionStart finds the project from the git remote, branch and folder of the cwd, calls `start_work` on the MCP endpoint and prints the brief as `hookSpecificOutput.additionalContext`. Stop blocks once (`{"decision":"block","reason":...}`) when the working tree differs from what SessionStart recorded and the session's transcript shows no `save_state` or `import_state` since.
- **Fail open:** no key, no network, an error answer, an unmatched project, a non-git folder or a 5 s timeout print nothing and exit 0. Stop never blocks twice in a session (a marker file `<tmp>/work-os-hooks/<session id>.json`), never when `stop_hook_active`, never without a recorded start.
- **Key:** `WORK_OS_KEY` (a Claude Code `wos_` key; the worker's own `wkr_` device key does not open `/api/mcp`, so it cannot be reused) and `WORK_OS_URL` (default: the worker config's `baseUrl`), both in the `env` block of the person's settings file.
- **Install:** the person pastes the snippet from Settings › AI tools › Claude Code into `~/.claude/settings.json`, replacing `PATH_TO_WORKER_FOLDER` with the unpacked `worker` folder. The worker and Work OS never edit that file, and never `~/.claude.json`.
- **Key exposure:** `WORK_OS_KEY` in the `env` block of `settings.json` is visible to every command Claude Code runs (the same exposure as the key in the MCP header it already has). Use a dedicated Claude Code key per machine (Claude › Setup › Claude Code key), so it can be revoked on its own in Settings.
- **Tests:** `worker/test/hook.test.mjs` and, against the real server, `tests/e2e/flow-hooks.mjs` (hook processes with real hook stdin, a seeded `wos_` key, real `start_work` and `save_state`). The output shapes were checked against code.claude.com/docs/en/hooks on 2026-11-15 (SessionStart `hookSpecificOutput.hookEventName` + `additionalContext`, capped at 10,000 characters; Stop `decision: "block"` + `reason`).
- **Unit tests:** `worker/test/hook.test.mjs` (stub MCP server and a temp git repo: brief as hook JSON, every fail-open path, the timeout, Stop once, not after a save, baseline kept after compaction). 
- **WORK-STATE.md copy (18 Nov):** `pre-tool` (PreToolUse on Edit/Write/MultiEdit/NotebookEdit/Bash/PowerShell) refuses hand edits of WORK-STATE.md; `post-tool` (PostToolUse on `mcp__.*__(save_state|import_state|get_state)`) writes WORK-STATE.md from the answer's `markdown` in the repo's main folder with a `<!-- work-os-copy sha1:... -->` stamp and commits that file alone (`git commit --only`); skips builder worktrees, other projects, older versions, merges/rebases; a hand-kept file is backed up to `<hook dir>/copies/` and its extra lines listed to the session. Needs no key. Tests in hook.test.mjs.
- **Install:** `node worker.mjs hooks install|remove|status` (worker/hooks-install.mjs): copies hook.mjs + config.mjs to `<worker config dir>/hooks`, merges the four entries into `~/.claude/settings.json` with a dated backup, keeps other settings and hooks, never touches ~/.claude.json. Setup for a new PC: docs/setup-pc.md.

## 8. Phone app (PWA)

### Om
- **Install:** iPhone: Safari → Share → **Add to Home Screen**. Android: Chrome → **Install app**. Long-press the icon for the **New task** and **Notes** shortcuts. On iPhone, sign in once inside the installed app.
- **Below 768px wide, the app uses the phone interface;** the laptop view doesn't change.
  - **Tab bar:** Today, Projects, **+**, Needs (with the count of open Needs for you), Tasks; **Menu** in the header (Claude, Inbox, Review, Schedule, What's new, Settings). Notes sit under Projects on the phone. The Menu button carries an amber dot while Claude waits on you, else a blue dot while something new is unseen.
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
    - **Filters** button opens a sheet for project, mode and due. Filters and search live in the URL (`/tasks?project=…&q=…`), so back works and a filtered view can be bookmarked.
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
  - **Projects, Review (Done, Activity, Stale, Archive, Trash), Schedule:** each has a phone layout with a back button, task rows like the Tasks tab, and no horizontal scrolling at 360–412px.
  - **Menu:** Claude (with what waits on you), Inbox, Review, Schedule, What's new (blue dot while something is unseen), Settings (with the server health dot).
  - **Needs** (the tab; **Needs** in the desktop sidebar, under Inbox, with the count): what waits on you (decisions, approvals, reviews of handed-in work, asks from teammates and Claude), the same cards as Today's "Needs you", answered with a tap; below, what you answered in the last 14 days. Empty, it says what will appear and how. **Tasks** (phone and desktop) shows "Needs you" on top with the first three and **See all** (nothing when none).
  - **What's new:** Today shows a "New in Work OS" card with features shipped in the last 14 days you have not seen (three, then "and N more"): **Try it** opens the feature and marks it seen, **Dismiss** hides them all. The **What's new** page (Menu, sidebar) lists every feature newest first, one line each and where to find it; opening it marks everything seen. A small **New** badge sits on a new feature's sidebar entry for 14 days (Needs now).
  - **Pull to refresh:** pull down at the top of any screen to reload its data (an installed app has no browser refresh). It's ignored while a sheet is open.
- **Offline:** shows a "You're offline" screen.

### Claude Code
- **Phone components:** `components/mobile/`
  - `tab-bar.tsx`: tab bar and `MobileHeader` (Menu button in the header)
  - `quick-add-sheet.tsx`
  - screens: `today/today-client.tsx` (Today for both sizes), `m-tasks.tsx`, `m-task-row.tsx`, `m-task-actions.tsx` (⋯ sheet), `m-task-detail.tsx`, `m-notes.tsx`, `m-day-plan.tsx`, `m-import.tsx`
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
- **How pages switch:** a page renders the phone view inside `md:hidden` and the desktop view inside `hidden md:block`. See `today/page.tsx`, `tasks/page.tsx` and `tasks/[id]/page.tsx`.
- **Menu:** `app/(app)/menu/page.tsx`.
- **What's new:** one data file, `lib/whats-new.ts` (`WHATS_NEW`, newest first; each entry: stable `id`, `date`, `title`, `line`, `where`, `href`, optional `badge` place from `BADGE_PLACES` and `requires: 'mail' | 'intake'` for features a deployment may not have set up). Shipping a user-facing feature adds one entry (AGENTS.md). An entry is new for `NEW_DAYS` (14) days from its date: Today's card (`today/whats-new-card.tsx`), the nav dot and its `<NewBadge>` (`components/new-badge.tsx`, rendered where the place is, e.g. the sidebar's Needs) all use that window. What each person has seen is `whatsNewSeen` (entry ids only) in their `profile:<userId>` settings (`lib/whats-new-seen.ts`, read once per request with React `cache`, and not at all while no entry is new); written only by `app/(app)/whats-new/actions.ts` (session cookie). The page is `app/(app)/whats-new/page.tsx` (`mark-seen.tsx` marks all seen 1.5 s after opening). The layout passes `needs`, `whatsNew` and `newBadges` in the nav badges (`components/app-context.tsx`). e2e: run.sh pins "today" with `E2E_WHATS_NEW_TODAY` (e2e database only): 2099-01-01 for every suite (nothing is new, so a new entry never changes them), 2026-11-20 for `whats-new`, 2026-11-29 for `whats-new-late` (14 days on: no card, dot or badge).
- **Needs page:** `app/(app)/needs/page.tsx` (open Needs to me via `openNeedsToMe`, answered to me in the last 14 days via `listNeeds`), rendered by `MyNeeds` in `components/needs.tsx` with the shared `NeedCard`. Tasks (`tasks/page.tsx`) passes `NeedsYou` with `max` 3 and `seeAll` to `MobileTasks` / `BoardClient` as `top`. The phone tab bar (`components/mobile/tab-bar.tsx`) has Needs where Claude was; `lib/nav.ts` `phoneTabOf` lights it on `/needs` and nothing on `/claude`. Empty states that say what appears and how: Needs page, project Needs tab, State card (`data-state-empty`), project Inbox (`data-inbox-empty`). e2e `whats-new`, `whats-new-late`, `nav`, `nav-cross`.
- **Claude page tabs** (Now, Queue, Workers, Set up) use one layout for both sizes. Workers (`claude/workers-tab.tsx`, data from `lib/data/roster.ts`) is a server component: one row per worker (person, AI client, model, account, machine, project, branch, doing, state, last seen), builders indented under their orchestrator, "Could be running and isn't" on top. A project page shows "Working on it now" and the same line for that project. Checked at 390 and 1280 in `flow-w1`.
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
Settings (`/settings?section=`; phone: Menu → Settings, laptop: sidebar "Settings") is laid out like Claude's own settings: a list on the left grouped **You / Team / Server**, a search box, and a status strip on top (push, alerts, email). On the phone it shows the rows, then the section.

| Section | What's there |
|---|---|
| **Account** | Theme; passkeys; authenticator app (QR, backup codes); change password; test email; Sign out (section 10) |
| **Notifications** | This device: Install app, phone push on/off and your push devices; switches per channel (push, Discord DM) and per alert type; **Send test**; quiet hours and timezone; link or unlink your Discord account (section 7) |
| **Connections** | Your connections (Claude, Discord, computers, Delpat OS); signed-in apps (OAuth) with Revoke; Delpat OS link (hidden while its env is unset); **Calendar link** (Create, Copy, Rotate, Turn off; one-way ICS of your own dated open tasks, `docs/calendar.md`) |
| **AI tools** | This server's MCP address and setup steps for Claude Code (tested), Cursor, Antigravity and ChatGPT (from their docs, marked not tested) (`docs/connect.md`) |
| **Get started** | First-run checklist ticked from real data |
| **Team** | Members, invite, cancel invitation, change role, remove; the organization's modes of work (read-only) |
| **Server** | Operators only (owner/admin see Discord): Discord server id, sensitive channels, register commands; when the scheduled alert check last ran; **Usage** (requests 24 h / 7 days by kind, caller and route; `docs/usage-log.md`) |

### Claude Code
- **Page:** `app/(app)/settings/page.tsx`; the device card, push and notification switches are client components in `device-settings.tsx`; server actions in `settings/actions.ts` (subscribe, unsubscribe, save switches, send test).
- **Status strip:** `settings/status-strip.tsx`; the sidebar/menu dot is `systemStatusLevel`. (`lib/status.ts`, the old seven-row panel, is no longer used.)
- **Sections:** `settings/sections.ts` (names, groups, legacy section names redirected).
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
- **The repo is public.** Secrets live only in `/etc/work-os/env` on the box and in the gitignored `.env.local`. Before each push, a scan checks that no secret is being committed.
- **Discord:** only Om's user ID, only in the Delpat server, sensitive channels blocked. The bot's permissions are View Channels and Read Message History only. Discord commands are not tied to a Work OS user yet (no `actorUserId`).

---

## 11. Still to do / known limits

What Work OS is for, and which flows are agreed, is in `docs/PRODUCT.md`; the ordered work list is `WORK-STATE.md`. This section only lists what is set up on the box and what isn't (14 Nov 2026).

**Live on work.delpat.in:** the app, the alert timer (`CRON_SECRET`), the reel publisher (IG keys, timer scripts, the cutroom booking key), the Caddy site with the no-502-on-restart lines.

**Not set up yet (each waits on Om):**
1. **Backups:** `deploy/backup.sh` and its timer are built but not enabled: needs an R2 bucket, token and age key, then a restore drill. Until then Atlas is the only copy of the data.
2. **Discord commands:** set the Interactions Endpoint URL in the Discord Developer Portal to `https://work.delpat.in/api/discord/interactions`, then Settings › Server › Discord › Register the commands.
3. **Delpat OS link:** `DELPAT_OS_CLIENT_SECRET` in `/etc/work-os/env`.
4. **Alerts on real devices:** Settings › Notifications › Send test has never been checked on the live site (push, Discord DM, email).
5. **Server reboot** for pending Ubuntu updates (check pm2 apps come back: `systemctl is-enabled pm2-ubuntu`).

**Known limits:**
- **Simultaneous edits:** if Claude edits a note you have open, your last few seconds of typing are lost when the page reloads (you're warned first).
- **Images and files** in notes are off until Blob storage is set up.
- **The worker edits `~/.claude.json`** (`worker/trust.mjs`) to trust linked folders; a clash with Claude Code's own write could lose settings. Open question in `docs/PRODUCT.md`.
- **Single process:** live refresh, some caches and the reel de-duplication are in memory; run one app process only.

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
- **Live pages:** every other page refreshes itself on a hint too: `components/live-refresh.tsx` sits once in the app layout and picks the topics from the path (Today: tasks, projects, claude, inbox; Tasks, a task and Modes: tasks, projects, inbox; Projects and a project: projects, tasks, and on a project also notes and claude; Review: review, tasks; every page: inbox for the unread badge). A refresh re-reads the layout, so the badges follow. It uses the Claude page's `AutoRefresh` with `poll={false}` (no poll while the stream is down; the catch-up hint after a gap refreshes once). Hints close together are one refresh; a hint waits while the person types in a field, has a dialog or sheet open, or an element marked `data-unsaved` is on the page, and lands when they leave it; a hidden tab catches up when shown. Every server action of the tab (watched in `window.fetch` by its `next-action` header) counts as a write: the person's own hint from it is not one more fetch, and its new page is re-rendered until it shows (the stale-page workaround, now for every page). Editable fields that start from the server use `useSynced` (`components/use-synced.ts`) so a refresh brings a teammate's change into them unless the person has changed that field; an uncontrolled field (`defaultValue`) gets a `key` of its value instead. `tests/e2e/live.mjs` covers it at 390 and 1280.
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
