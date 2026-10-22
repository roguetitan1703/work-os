# Multi-user Work OS

Decided 2026-10-22 (Om): Work OS becomes a multi-user tool for the Delpat team, with its own sign-in for now. How it joins Delpat OS (shared sign-in, shared project list) is decided later; nothing here may block Delpat OS becoming the sign-in provider (Better Auth on both sides, users keyed by email).

Background: Vercel paused Om's account on 2026-10-19 (Fluid Active CPU). Work OS moves to Delpat's AWS server (work.delpat.in). The audits behind this plan are summarised at the end.

## Decisions (defaults; change here first, then in code)

**Tenancy.** An organization (workspace) holds people, projects and everything in them. A user can belong to more than one; v1 has one: Delpat. Every stored document carries `orgId`. Documents that belong to one person also carry `ownerId` (a user id).

**Private vs shared.**
| Private to its owner | Shared with the organization |
|---|---|
| Tasks and notes with no project, or in a personal project | Projects (not personal), their tasks, notes, Claude items, activity |
| Schedule, routines, timezone, quiet hours, notification settings, inbox, push devices | Members and roles, task assignment, comments |
| Computers (worker devices), agent sessions, MCP/API keys, dispatcher settings | Who did what (people and agents) on shared work |

A project has `visibility: 'org' | 'private'`; a task or note follows its project, and one with no project is private to its owner. v1: every member sees every shared project (per-project membership comes later if needed). Roles: `owner`, `admin`, `member`.

**Numbers.** Task and Claude item numbers (#12, C3) are per organization: unique index `(orgId, ref)`. Project names unique per organization.

**Who did it.** `actor` becomes `{ kind: 'user' | 'agent' | 'discord' | 'system', userId?, agent?: 'claude' | 'claude-code' }`. An agent always acts for a user (the key's owner). Rules that said "only Om" now say "only a person" (kind `user`), and "the owner" means the task's owner or assignee. `waitingOnOm` becomes `waitingOn: userId`.

**Sign-in.** Better Auth (same library as AKAR, current 1.7.x) with the MongoDB adapter on the existing Atlas database: email and password, invitation-only sign-up through the organization plugin, two-factor (TOTP with backup codes), passkeys. Password reset by email to the user's own address. The old single password, session generation, `security` settings doc, passkeys and recovery codes are retired; Om becomes the first user and owner of Delpat and sets a new password through a reset link.

**Keys.** Better Auth's API key plugin replaces `MCP_TOKEN` and `wos_` keys: each key belongs to a user and says which agent it is (claude chat, Claude Code). Worker device keys (`wkr_`) also belong to a user. Later: Better Auth's MCP/OAuth support so teammates add Work OS as a Claude connector without pasting a key.

**Per-user settings.** Timezone, quiet hours, notifications, Discord link, dispatcher switch and its rules note, schedule. Om's current timetable (`lib/schedule.ts`), modes and Fiverr routine become his data, not code; new users start with none (no schedule bar, no routine card). Modes become an organization list seeded with today's 8.

**Inbox, push, alerts.** Every notification has a recipient `userId`; alerts go to the task's assignee, else its owner. Push goes only to the recipient's devices. Discord: each user links their own Discord id; the guild is an organization setting.

**One door for data.** Every data function takes the caller `{ userId, orgId }` and every query goes through one scoped helper that adds `orgId` and the visibility rule. A test fails the build if a collection is queried without it.

**Hosting.** Long-running Node server on EC2 (next start behind a reverse proxy, process manager, CPU credits "standard"). The worker and open pages get changes pushed over a WebSocket instead of polling (phase 5). Crons run on the server.

## Phases

0. **CPU first** (before deploying anywhere): projections on note/task lists, preloader cut to the pages people use, no hover prefetch of whole pages, session check cached in process, indexes created once per process, worker and Claude page polling made cheap until phase 5 replaces them.
1. **Sign-in**: Better Auth, users, organization, roles, invitations, 2FA, passkeys, reset by email, API keys for MCP and devices. Om migrated as the first user. Every request knows its user and organization.
2. **Ownership**: `orgId`/`ownerId`/`visibility` on every document (migration script, dry run first, run against a copy before Atlas), scoped data layer, per-organization numbers, actor model.
3. **Per-user settings**: schedule, routines and modes as data; timezone, quiet hours, notifications, Discord link, dispatcher per user; inbox recipients; "Om" removed from code and texts.
4. **Team**: invite page, members and roles, assignee on tasks, "assigned to me" views.
5. **Hosting**: EC2 at work.delpat.in, WebSocket push for the worker and pages, server crons, backups. With Akash.

Each phase ships with its e2e suites passing and a security review before merge (phases 1, 2 and anything touching access).

## As built: phase 2, ownership (2026-10-22)

**Fields.** Shared collections (projects, tasks, activity, notes, claudeItems, trash) carry `orgId`, `ownerId`, `visibility`. Tasks also have `assigneeId` (null until phase 4 adds assigning). Children copy their placement: a task, note, Claude item, history entry or trash entry lives where its project lives. With no project it is private to its owner. In a private project it is private to the project's owner. Personal collections carry `orgId` plus `ownerId` (reviews, ritualLogs, devices, workerFolders/Jobs/Sessions) or the recipient `userId` (notifications, pushSubs, alertLog, alertQueue). Counters are `task:<orgId>` and `claudeItems:<orgId>`. Indexes: `(orgId, ref)` unique on tasks and claudeItems; on projects, `(orgId, name)` unique among shared ones and `(orgId, ownerId, name)` unique among private ones; `(ownerId, date)` unique on ritualLogs.

**One door.** `lib/scope.ts`. Every data function takes the caller's scope `{ userId, orgId }` first. `scoped(s)` returns the collections behind a proxy that:
- adds the rule to every filter: shared = `orgId` and (`visibility: 'org'` or `ownerId` = caller); own = `orgId` and `ownerId`/`userId` = caller; counters = `orgId`;
- stamps inserts and upserts with `orgId` (and the owner field);
- refuses updates that touch `orgId`, plus `$unionWith`, `$graphLookup`, `$out`, `$merge` and `$facet`;
- scopes the sub-pipeline of a `$lookup`.

`orgWide(orgId)` drops the visibility rule. It is used only by system work: unblocked fan-out, the alert flush and restoring a task to where its project is now. Settings are read only through `getUserSetting`/`setUserSetting` (`<area>:<userId>` for notify, dispatcher, alerts, status) and `getOrgSetting`/`setOrgSetting` (`discord:<orgId>`).

The check: `tests/scope-check.mjs` runs as `prebuild` and in the tenancy suite. It fails if anything in lib/ (except db.ts and scope.ts) or app/ reaches `collections()`, `getDb()` or `.collection()` on a line without `// scope-ok: <reason>`. Files that read only Better Auth's own collections (people, auth-server, auth-limits, caller, fresh, members) are allowed whole. The marked exceptions are:
- request counters;
- policy events per API key;
- the old-alert and inbox prune;
- push endpoint takeover;
- Better Auth tables;
- the one-off authMigration notice;
- computers (every query filters by the caller or the key's hash) and the mail log.

**Moving and sharing.**
- Moving a task to another project re-places it. Only its owner may take a shared task private.
- A project's visibility is changed by its owner only. The change cascades to its tasks, history, notes, Claude items and trash (a trashed task's history and note too).
- Restoring a task from the trash recomputes where it lives from its project as it is now (and moves its history and note with it). Someone who could not see the result gets "not in the trash".
- New project ids are the name's slug plus a random tail (`zephyr-shared-3f9a1c2e`): ids are global, so a bare slug, or a `-2` suffix, would tell one organization what another has named its projects. Existing ids stay.
- **Project names** are unique among the projects a person can see. A refusal says only "You already have a project with that name", and only for a project you can see. So two people can each have a private project with the same name, and a teammate can make a shared project with the name of your private one (you then see both; a lookup by name picks your private one). Making a project shared is refused if a shared project already has that name. We chose this over one name per organization because a refusal for a name you cannot see tells you that someone has a private project of that name.

**Who did it.** Actors are objects (`lib/actors.ts`). The app sets `{kind:'user', userId}`. MCP keys set `{kind:'agent', agent, userId: key owner}`. Discord sets `{kind:'discord', userId}`. Migrations set `{kind:'system'}`. Old string actors are still read (`asActor`). "Only Om" rules now mean "only a person":
- marking next;
- clearing a Claude item's waiting;
- dispatcher marking;
- the boilerplate note (only the person whose dispatcher reads it).

Comment edits: an agent may edit only entries of the same agent for the same user. A person may edit their own entries and those of their agents.

**Recipients.** `recipientOf(task)` = the assignee of a shared task, else the owner.
- Alerts are computed per person (`recipientFilter`) with that person's settings.
- The cron iterates every membership and writes `alerts:<userId>`.
- Unblocked alerts are queued to the waiting task's recipient. Dispatcher outcomes go to the person who gave the task to Claude.
- Push goes only to that person's subscriptions; a browser that turns push on takes its endpoint over from whoever had it.
- The Discord DM goes only to the Discord-linked person.
- Claude Code change notices go to each changed task's recipient.
- "Claude needs you" goes to `waitingOn`.

**MCP.** The server acts for the key's user in the key's organization. Tool names are unchanged. Renamed or new fields:
- Claude items: output `waitingOnOm` became `waitingText` (what) plus `waitingOn` ('me' or the member's name). `get_project` → `claudeItems.waitingOnOm` (a count) became `waiting`.
- `update_claude_items` add/block take `waiting_on` (a member id or email; default the key's owner) next to `waiting_on_om` (the text). Someone outside the organization is refused. A private item can wait only on its owner.
- `add_project`/`update_project` and the apply_changes ops take `visibility`. `get_task`, `list_projects` and `get_project` return it.
- `by`, `createdBy`, `doneBy` and `updatedBy` are strings as before ('me', 'claude', 'claude-code', 'discord', 'system') for the key's owner. For anyone else they hold the name, e.g. 'Ana' or 'claude-code for Ana'.
- `recent_activity` `actor` filters the caller's own kinds ('me' = the caller in the app).

**Discord.** Until phase 3 links each person's Discord id, the bot acts for the owner of the first organization (`discordScope()` in lib/people.ts). Commands and Discord-made tasks belong to that person, and if there is no organization they are refused. The four Discord MCP tools work only for keys of that person. The blocked-channel list is `discord:<orgId>`; it can be edited by owners and admins of that organization.

**Workers and files.**
- A computer acts as its owner. Computers with no owner are refused (401).
- The dispatcher's switch, cap and claims are per person.
- Note files are stored under `notes/<orgId>/<noteId>/<name>` and belong to that note: the upload route needs a live note the caller can see, and the file route serves a file only to people who can see its note (a private note's files are its owner's). Other path shapes are not served (uploads were switched off before this layout). Only png, jpeg, gif and webp are shown inline; every other type downloads with a type that cannot render as a page, and every file is sent with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Uploads accept a fixed list of types (no SVG or HTML). Rules: `lib/note-files.ts`.

**The operator.** `OPERATOR_EMAILS` (comma list, `lib/operator.ts`) names who runs the deployment. Only they get `/api/admin/health`, `/api/admin/discord/register` and Settings › Usage (the request log of the whole deployment). An organization's owner or admin is not an operator unless listed. Until phase 3 gives each person a schedule, the built-in schedule (`/timetable`, `/api/timetable/today`) is the operator's: everyone else gets an empty one.

**Migration.** Run `scripts/migrate-ownership.mjs --db <name>`. It is a dry run that prints counts only; `--apply` writes. `--copy-to <new db>` copies the database first and migrates the copy, never writing to the source. It is idempotent. It does the following:
- assigns everything to the first organization and its owner;
- makes projects `org`;
- makes tasks and notes with no project private;
- converts actors;
- turns `waitingOnOm` into `waitingText`/`waitingOn`;
- rebuilds `task:`/`claudeItems:` counters from the highest ref;
- moves settings to `<area>:<userId>` / `discord:<orgId>`;
- stamps `orgId` on the authMigration notice;
- gives tasks already given to Claude `claude.markedByUserId`/`markedByOrgId` (Om, the first organization).

Order on deploy: deploy the code, then run the migration at once. Until it runs, old documents are invisible because they have no `orgId`.

## As built: phase 3, per-user settings (2026-10-22)

**Each person's own settings** live in `settings` through `lib/scope.ts`, one document per person or organization:
- `profile:<userId>` (`lib/profile.ts`): timezone, quiet hours (whole hours, default 23–8; equal = none) and the linked Discord account.
- `schedule:<userId>` (`lib/user-schedule.ts`, shape in `lib/schedule.ts`): the weekday time blocks, colours for block names that are not modes, which mode's tasks fill a block (`taskModes`), one routine, the weekly review questions and help sections.
- `modes:<orgId>` (`lib/org-modes.ts`): the organization's modes. With no document it is the eight from `lib/modes.ts` `DEFAULT_MODES`.
- `discord:<orgId>`: the organization's Discord server (`guildId`, unique across organizations) and its blocked channels.

**Schedule as data.** Nothing about one person's week is in code any more: `SCHEDULE`, the Fiverr routine card and `RITUAL_MODE_MAP` are gone. A person with no schedule gets no block bar, no page tint, no Now line and no Schedule button on Today, and no routine card. `/timetable` shows your own week; `/timetable?edit=1` is a small editor (blocks with a mode per weekday, the routine on or off). The routine card is generic (`components/routine-card.tsx`): a name, times, a colour, what is counted and the question. Its logs keep the `ritualLogs` collection, with `count` in place of `bidsPlaced`. Weekly reviews store `answers` keyed by the person's questions (default: shipped, slipped, to drop, adjustments); old reviews with fixed fields are read as answers, and saving one moves them. Help (Settings › Help) shows the organization's modes and the person's own help sections.

**Modes.** A task's mode must be one of the organization's modes (`canonicalMode`, the organization's spelling); an unchanged mode is not checked again, so a task keeps a mode the organization later drops. The sidebar, menu, filters, forms, quick add, imports, Discord's `/task` choices and the MCP instructions all read the list. There is no editor yet.

**Timezone.** No timezone is hard-coded. `currentTz()` (`lib/dates.ts`) is the person's timezone: the request context carries it for actions, API routes, MCP, the worker and the cron (each person's run). For pages, `getCaller()` puts it in a per-render cell, and in the browser the app shell sets it. `APP_TZ` is now only the default for people who have not chosen one (else UTC). Alerts use each person's timezone and quiet hours. Settings › Alerts sets both.

**Discord, per person.**
- One bot for the deployment: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`. `DISCORD_GUILD_ID` and `DISCORD_OWNER_ID` are no longer read.
- The operator sets each organization's server in Settings › Connections › Discord, and registers that server's commands (`POST /api/admin/discord/register?org=<id>`; the mode choices are the organization's). A server belongs to one organization.
- Linking: Settings makes an 8-character code (stored hashed, 10 minutes, used once); the person runs `/link <code>` on the organization's server; the signed interaction proves which Discord account it was. One account links to one person in an organization: linking it again moves it.
- Interactions: the server picks the organization, the sender's linked account picks the person (who must still be a member). Everything runs as them, in their timezone. Anyone not linked gets "not linked", with how to link.
- The Discord MCP tools need the key owner's account linked. Reads show only what that Discord account can see on the server: channel permissions are computed from their own roles. Private threads are shown only to a server administrator, because membership is not known without a call per thread. A channel id not in the list is allowed only for a thread whose parent channel they can see. Blocked channels apply to everyone.
- Alert DMs go to the recipient's own linked account; no account, no DM.

**Dispatcher.** Each person's switch, rules note and cap (phase 2); the cap counts only their own running claims. The tenancy suite checks that two people's caps and switches do not affect each other.

**"Om" out of code.** User-facing text, MCP instructions and tool descriptions, policy messages and comments say "you", the person's name or "the owner". The MCP instructions name the key's owner and list the organization's modes (`instructions({ name, modes })`; the server pool keys on both). Docs and history are unchanged; the MCP argument `waiting_on_om` keeps its name.

**Migration.** `scripts/migrate-phase3.mjs --db <name>` is a dry run that prints counts only; `--apply` writes. It is idempotent and never overwrites what is already set. It gives the first organization's owner the old timetable, routine, review questions and help (`scripts/lib/legacy-week.mjs`) and a timezone (`--tz`, else `APP_TZ`, else Asia/Kolkata). It also does the following:
- sets the owner's Discord account from `DISCORD_OWNER_ID` and the organization's server from `DISCORD_GUILD_ID`;
- seeds the organization's eight modes, with their original descriptions;
- turns old reviews into `answers` and `bidsPlaced` into `count`.

Run it after the deploy, then register the Discord commands again (they gain `/link`), then remove the two old Discord variables.

## As built: phase 4, team (2026-10-22)

**Members** (Settings › Members, `lib/members.ts`, `app/(app)/settings/members-section.tsx`). Owners and admins:
- invite by email (role member, admin or owner), see pending invitations, and cancel them;
- change a member's role with the select on their row;
- remove a member (Remove, then confirm).

Who may do what:
- Only an owner makes someone an owner, and only an owner changes or removes an owner. Admins manage admins and members.
- An owner may step down on their own row. Nobody removes themselves.
- **There is always an owner.** A demotion of an owner is refused while they are the only one. The write is checked again after it is made and undone if it left none, so two owners demoting each other at the same moment cannot both win. Removing an owner first demotes them through the same guarded step.
- The server checks every rule (`changeRole`, `removeMember`); the page only hides what you cannot do.
- Changes are direct writes to Better Auth's `member` collection, not through its organization endpoints. Those endpoints stay off (docs/auth.md), and our rules (last owner, admins and owners) are not Better Auth's.

**Removing a member** ends their access to that organization at once:
- the membership is deleted;
- their sessions whose active organization is this one are deleted, so an open browser is signed out on its next request;
- their Claude chat and Claude Code keys for this organization are deleted (keys for other organizations stay);
- their computers there are revoked and pending jobs cancelled. The worker routes also refuse a computer whose owner is no longer a member;
- tasks they gave to Claude end as "stopped";
- shared tasks assigned to them are unassigned, so alerts go back to each task's owner.
- invitations they sent that are still pending are cancelled (they may hold the links);
- alerts queued for them and not yet sent are dropped, and sending queued alerts skips anyone who is no longer a member.

Changing roles or removing reads the caller's own role fresh from the database, not the cached one. Better Auth's
`get-full-organization` shows invitations only to owners and admins and never their `tokenHash`; `list-invitations` is
not served (nothing used it).

The role and member-name caches now live on `globalThis` and are cleared in the process that made the change; other server instances catch up within a minute (phase 5 has one server).

**A removed member's private data: kept untouched and unreachable.**
- Their private projects, tasks, notes, settings, inbox and computers (revoked) stay in the database as they were, and nobody else can see them: the door shows private things only to their owner, who is no longer a member.
- Invited again, they find everything where they left it (but must add their computers and keys again).
- Shared work they made stays shared and keeps them as owner.
- Nothing is deleted, so nothing is lost by a removal made in error.

To erase someone's data, delete it by hand in the database (no tool yet).

**Assignee** (`lib/data/tasks.ts`):
- Any member can be assigned to a task in a shared project.
- A private task can be assigned only to its owner. Anyone else is refused ("move it to a shared project first"), in the app, MCP and `apply_changes`.
- A task that becomes private loses an assignee who is not its owner. This holds when the task moves out of its shared project, when its project is made private, and when it is restored into a private place.
- History records the change by name ("assignee Bea → —").
- Input: `assignee` on `TaskInput`/`TaskPatch`: a member's user id or email, `me`, or null to clear. Someone outside the organization is refused. `findMember` falls back to the database for someone who joined in the last minute.

**Alerts to the assignee.**
- `recipientOf` was already "the assignee of a shared task, else its owner", and the cron, unblocked alerts and Claude Code notices all use it.
- What was missing: alert log keys were per task, so a task that changed hands never alerted its new recipient for an occasion already logged. An assignee's keys now carry their user id (`overdue:<task>:<due>:<user>`). The owner's keys keep the old form, so nothing already sent goes out again after the deploy.
- Assigning someone queues an `assigned` alert to them in the alert queue (in the same transaction as the task write). It is sent right after the write: inbox always, phone push and Discord DM by their settings, held in their quiet hours. It is dropped if the task changed hands again, closed or was archived before it went out.
- Assigning yourself sends nothing. "Assigned to you" is a new switch in Settings › Alerts (on by default).

**Views.**
- Tasks: an **Assigned to me** button (desktop) and chip (phone) set `?assigned=me`, which lists only tasks assigned to you.
- Today: an **Assigned to you** section with your assigned tasks that no section above already shows, and a link to the full list.
- The task page (desktop "Assigned to" field, phone "Assigned" row) has the picker: Nobody, Me, then everyone in the organization. A private task shows "Private: only you" instead.

**MCP.**
- `add_task`, `update_task` and the `create_task`/`update_task` ops of `apply_changes` take `assignee` ('me', an email or a user id; null clears).
- `list_tasks` takes `assignee` as a filter.
- `get_task` and every brief task (list_tasks, add/update answers) return `assignee`: 'me' or the member's name.

**Invitation links: one switch** (`INVITE_LINK_TO_INVITER`, `inviteLinkToInviter()` in lib/members.ts).
- Default (unset or `1`): the current behaviour. The inviter sees the link (to copy when email is off), and it is also emailed.
- `0`: the link only goes by email, so an owner or admin can never open an invitee's link and claim the account. Inviting then needs working email: without it the invite is refused, and if the email cannot be sent the invitation is cancelled and the inviter is told to try again.
- Om has not decided which he wants (WORK-STATE Later).

**Phase 2 review leftovers, fixed.**
- **Take-back through sub-pages.** Editing, adding, deleting or restoring any page under a task's note (any depth) takes the task back from Claude: the note's root `taskId` is found by walking up `parentId`.
- **Take-back race.** `takeBackOnEdit` now runs *before* the edit is written. It reads the mark fresh and ends it with a conditional update, retried if a claim moved it meanwhile (queued → running). A claim (`claimFor`) starts a task only if its mark is still `queued`, in one atomic update. So a session either started before the edit (it read the old text, and is stopped) or never starts.
- **Org → private onto a name you use privately** now answers "You already have a private project with that name" before anything moves. Before, it was a 500 after the cascade had already run.
- **`restoreTask`** puts the task, history and note back first and deletes the trash entry last. A failure part-way leaves the trash entry, and a retry says "#12 already exists", rather than losing the task.

Tests: `tests/e2e/team.mjs` (new). It covers:
- assignee rules and notices;
- alerts following the assignee;
- take-back through sub-pages, a new sub-page, a delete and a comment;
- the private-name clash and restore order;
- invite, revoke, accept, role changes, the last-owner guard, stepping down and promoting back;
- removing a member (keys, computer, sessions, claims, assignments, private data kept), and removing a second owner;
- the pickers and the Assigned views on desktop and phone.

## As built: phase 5 push (2026-10-22, the code part)

Open pages and workers are told when something changed instead of asking every 30 s. Server setup it needs: docs/hosting.md §12 "Push" and deploy/nginx/work-os.conf. The page stream is `/api/stream`, not `/api/live` (that is the liveness route outside the proxy).

**Server-Sent Events, not WebSockets.** Every message goes one way (server to client); writes still go through server actions and the worker's HTTP routes. SSE is a plain GET that a Next 16 route handler can stream (`ReadableStream`), so it runs under `next start` and `next dev` as they are: no custom server, no `server.mjs`, nothing outside Next's router. The browser's `EventSource` sends the session cookie by itself. The worker reads the stream with `fetch` (Node 20+, no new dependency). A WebSocket would need a custom server for the upgrade, and Next's docs advise against one.

**Two streams.**
- `GET /api/stream` (pages). The proxy's session check runs first. The route then checks the session and the membership in its organization again (`callerFromHeaders`). Events: `hello`, `hint {t, s?}`, `bye {r}`, a ping comment every 25 s.
- `GET /api/worker/stream` (workers). It makes the same check as every worker route (`workerDevice` in lib/worker-route.ts): a `wkr_` key that is not revoked, an owner who is still a member, and the rate limit. Events: `hello`, `jobs`, `bye`.
- Limits (lib/live.ts): at most 10 page streams per person (across organizations) and 2 worker streams per computer. A new one past that closes the oldest with `bye {r:'limit'}`; that tab stays on its slow poll until it is back in view, and that worker waits a minute before trying again. Removing a member or revoking a computer also refuses new streams for that person or computer for 30 seconds, so a stream that passed its check just before the removal cannot register just after it. nginx adds per-address limits (docs/hosting.md "Push").
- If the read that works out who should get a hint fails, the write still goes through and only the writer gets the hint (never the whole organization).
- Each stream lives at most 30 minutes (`STREAM_TTL_MS`). The server then sends `bye {r:'ttl'}` and the client reconnects at once, so the session, membership and key are checked again at least every 30 minutes.
- Removing a member closes their page and worker streams at once (`closeFor` in `releaseAccess`), and revoking a computer closes its stream (`closeDevice`). A reconnect is then refused.
- The hub is `lib/live.ts`, in memory, on `globalThis`. That works because there is one server process. More than one instance would need a shared bus (Redis, or change streams) (WORK-STATE Later).

**Fan-out happens in the write path, not in change streams.** Every write already passes through the door (`lib/scope.ts`), which knows who is writing and the visibility rules. `pushed()` wraps each write on a collection that has a topic:
- tasks, activity and trash are `tasks`; projects are `projects`; notes are `notes`;
- Claude items, computers, folders, jobs and sessions are `claude`;
- the inbox is `inbox`; weekly reviews and routine logs are `review`.

Once the write has committed (`afterCommit` in lib/db.ts; a rollback or a dry run sends nothing), the people who can read what it touched get a hint. Who that is follows the scope rules:
- a shared document placed `org` reaches everyone in the organization; a private one reaches its owner;
- a personal document reaches its owner or recipient;
- both the before and the after placement count. So when a shared project is made private, the teammates who lose it hear about it too.

What this costs per write:
- nothing, and no extra read, while nobody in the organization has a page open;
- no read when only the writer has one open (they can see everything their write touched);
- otherwise one small `$group` read through the door's filter, before the write.

We chose this over change streams for three reasons:
- the audience is computed from the same rules and the same caller as the write, before and after;
- deletes and visibility changes need no pre-images, which change streams would need set up on Atlas;
- it needs no change-stream support from the Atlas tier, and opens no extra connection.

The cost: writes that bypass the door (raw `// scope-ok` lines, Better Auth's collections, settings) send nothing unless they say so. Those that matter call `wake`/`hint` themselves.

**Hints say nothing.** A hint is `{t: 'tasks'}`, plus `s: 1` when the change was the person's own (so a tab that is in the middle of its own write skips it). It carries no title, id or name, so a leaked event says only that something of yours changed.

**Pages.**
- `components/live.ts` opens one stream per tab, and only while something on the page listens (today only the Claude page's `AutoRefresh`).
- It closes the stream when the tab has been out of view for a minute. Hints that come while the tab is hidden wait until it is visible again.
- It reconnects with backoff (1 s, doubling to 60 s, with jitter). After a gap it sends listeners one `*` hint, since something may have changed meanwhile.
- `AutoRefresh` refreshes on a `claude` or `tasks` hint through the existing path (`router.refresh()`, skipped or delayed while a `write()` lands). It re-renders until the new page is on screen, the same workaround `write()` uses.
- It polls every 30 s, and refreshes on focus, only while the stream is down (the old behaviour).
- Other pages never polled and are unchanged; they could listen with one line (WORK-STATE Later).

**Worker** (worker/push.mjs, worker/loop.mjs).
- The stream's `jobs` event makes the worker poll `/api/worker/jobs` at once. The job itself still comes from that route, so claims, hand-out and validation stay in one place.
- A wake comes from: a start, resume or stop job; a folder linked or unlinked; a task given to Claude; the dispatcher turned on; a running claim that ended (a slot is free).
- With the stream up, the poll is a 5-minute fallback (10 s while a job or a starting session is open, as before).
- With the stream up, status goes out every 2 minutes only while a Work OS session runs or job results wait. Otherwise it goes only when what it reports changed, and at least every 30 minutes.
- On the server, a connected computer counts as online, and its last report counts as current (`connectedDevice`).
- A status report hints the person's Claude page only when what the page shows changed: counts, sessions, working/open/idle, a job result, a session state. Folder rescans hint only for new or vanished folders.
- The stream reconnects with backoff, waits 5 minutes after the key is refused, and waits 30 minutes when the server has no push route (an older deployment). It drops a connection that has been silent for 70 s.

**Tests.** `tests/e2e/push.mjs`:
- who may connect, to each stream;
- a teammate and the writer get a hint for shared work; the hint is marked as the writer's own for the writer;
- for a private task, nobody else in the organization gets anything, and another organization gets nothing at all;
- hints carry only a topic;
- a project made private reaches the teammate who loses it;
- an open Claude page shows a teammate's new item without a reload;
- the real worker client gets a stop job pushed (about 0.3 to 0.4 s from the click);
- removing a member closes their page and worker streams, and a reconnect is refused;
- the request counts (docs/cpu.md).

The worker's own tests cover the stream client, change-only status and a simulated hour of the loop.

## Leak audit (2026-10-23)

`tests/e2e/leak-audit.mjs` (in `tests/e2e/run.sh`, stub Discord, about a minute) calls every way into the app as several people and fails on anything one of them should not see or change.

**What it covers.** `tests/e2e/entry-points.mjs` reads every entry point from the code, not a hand list: route handlers and their methods, the Better Auth endpoints the auth route serves, server actions (`'use server'` exports and inline ones), pages, MCP tools, and Discord commands, autocompletes and buttons (181 today; `node tests/e2e/entry-points.mjs` lists them). The suite fails on an entry point with no audit entry, and on an action in the build that is not an enumerated export. For each entry point it checks:
- **reads:** unique marker strings (canaries) are planted in every private and other-organization document (titles, descriptions, notes, comments, Claude items, schedules, reviews, inbox, push devices, computers, folders, prompts, keys, Discord messages, invitation tokens). Every answer (body, Discord reply, alert DM, push event) is scanned; a canary its reader may not see is a leak;
- **writes:** every collection, Better Auth's included, is read before and after each person's calls, and every change is checked against who may write that document;
- **existence:** every aimed call runs again with a made-up id, number or name of the same shape, and "not yours" must answer like "does not exist";
- **refusals are real:** the owner makes the same calls on their own things (controls), and they must work; no aimed call may be refused by a server error; for each kind of entry point some refusals must read as the access check ("not found", a sign-in redirect, 401/403/404);
- **keys where they don't belong:** worker keys on MCP, chat and Claude Code keys on worker routes and pages, keys on server actions, a removed member's keys and computer, the cron secret in a URL, Better Auth endpoints that are not served, and a cookie copied before sign-out on a server action.

**Personas.**
- **A** owns the first organization: the controls.
- **T** is a member there, aimed at A's private things.
- **X** owns a second organization (with its own Discord server), aimed at the first organization's shared work. X's task and Claude item numbers start at 50000, so a number X sends is never X's own.
- **R** was a member, removed through Settings › Members; the removal's clean-up is then undone (session, keys, computer back), so only the missing membership keeps R out.
- **N** has no credentials.

**Adding an entry point.** A new route, action, page, MCP tool or Discord command fails the suite with "unaudited entry point: …" until it has an entry in `AUDIT()` at the end of the suite: `add('<id>', probe, …)`.
- Use the helpers: `M`/`Mc` for MCP, `act` for actions, `pg` for pages, `route`, `worker`, `authEp`, `disc`.
- Aim it with `aim([...target keys])` when it takes an id, number or name of someone else's document. The targets are in `TARGET`, `FAKE` and `OWN`; add a key there if it needs a new kind of document, and plant a canary in that document.
- Give it an `ok` that tells "it worked" from a refusal (an empty list is a refusal).
- Check that the owner's control passes. Use `stage: 1` or `2` if the call destroys its target, and give it its own target if another control destroys the same one.
- Run with `LEAK_AUDIT_LIST=1` to print every refusal, and check that they read as the access check, not as a validation error.
- The probe options are listed above `AUDIT()`.

**Accepted differences** (marked `existenceOk`, or by design):
- `/api/auth/passkey/delete-passkey` and `update-passkey`: Better Auth answers 401 for someone else's passkey and 404 for none. Passkey ids are random and never shown to anyone else.
- Task and Claude item numbers are per organization, so a new number tells a member how many there are (by design).
- R still has an account: their own `get-session`, `list-sessions`, passkey list and options, and organization list answer (the organization list is empty).
- A name nobody can see, given as a task's project (add, move, import), makes the caller a project of that name. This happens alike for a real and a made-up name (by design). The suite removes these after each call.
- Sign-in with a wrong password and password reset answer the same for a known and an unknown email (checked, no exception).

**Found and fixed** by the first run:
- Server actions and POST routes read the session through Better Auth's cookie cache. So a copy of a cookie kept after sign-out (or a revoked session) could still write for up to 2 minutes. They now read the session from the database (`callerFromHeaders` in lib/caller.ts). Pages and GET routes still use the cache (docs/auth.md).
- Cancelling another organization's invitation answered "Member not found" (Better Auth) instead of "Invitation not found". So an owner of one organization could tell that an invitation id of another was real. `cancelInvitation` now checks first that the invitation is in the caller's organization. `/api/auth/organization/cancel-invitation` is no longer served: nothing used it, and Settings › Members uses the server action.

## Audit summary (2026-10-19)

- All 26 collections have no owner or organization field; numbers, project names and Claude item numbers are globally unique.
- Sign-in is one shared password; the cookie carries no user. `MCP_TOKEN` is a full-access global key; `wos_` and `wkr_` keys have no owner.
- About 15 server actions and 3 API routes rely only on the proxy; the rest check "signed in", never who.
- "Om" is load-bearing in 26 files (MCP instructions, policy, claude-items, alerts, Discord). Timezone and quiet hours are fixed.
- Om's timetable, modes, Fiverr routine and weekly review fields are code.
- CPU: the live version refreshed the Claude page every 10 s and re-rendered 7 pages after each refresh (about 23,000 renders a day). Still present: worker polling (2,880 to 8,640 calls a day, 8 to 16 queries each), a database read for the session on almost every request, heavy page queries without projections.
