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

**Fields.** Shared collections (projects, tasks, activity, notes, claudeItems, trash) carry `orgId`, `ownerId`, `visibility`. Tasks also have `assigneeId` (null until phase 4 adds assigning). Children copy their placement: a task, note, Claude item, history entry or trash entry lives where its project lives. With no project it is private to its owner. In a private project it is private to the project's owner. Personal collections carry `orgId` plus `ownerId` (reviews, ritualLogs, devices, workerFolders/Jobs/Sessions) or the recipient `userId` (notifications, pushSubs, alertLog, alertQueue). Counters are `task:<orgId>` and `claudeItems:<orgId>`. Indexes: `(orgId, ref)` unique on tasks and claudeItems, `(orgId, name)` unique on projects, `(ownerId, date)` unique on ritualLogs.

**One door.** `lib/scope.ts`. Every data function takes the caller's scope `{ userId, orgId }` first. `scoped(s)` returns the collections behind a proxy that:
- adds the rule to every filter: shared = `orgId` and (`visibility: 'org'` or `ownerId` = caller); own = `orgId` and `ownerId`/`userId` = caller; counters = `orgId`;
- stamps inserts and upserts with `orgId` (and the owner field);
- refuses updates that touch `orgId`, plus `$unionWith`, `$graphLookup`, `$out`, `$merge` and `$facet`;
- scopes the sub-pipeline of a `$lookup`.

`orgWide(orgId)` drops the visibility rule. It is used only by system work: unblocked fan-out, the alert flush and project-name uniqueness. Settings are read only through `getUserSetting`/`setUserSetting` (`<area>:<userId>` for notify, dispatcher, alerts, status) and `getOrgSetting`/`setOrgSetting` (`discord:<orgId>`).

The check: `tests/scope-check.mjs` runs as `prebuild` and in the tenancy suite. It fails if lib/data, lib/mcp, lib/alerts, lib/notify, lib/discord, lib/status or app/ reach `collections()`, `getDb()` or `.collection()` on a line without `// scope-ok: <reason>`. The marked exceptions are:
- request counters;
- policy events per API key;
- the old-alert and inbox prune;
- push endpoint takeover;
- Better Auth tables;
- the one-off authMigration notice.

**Moving and sharing.**
- Moving a task to another project re-places it. Only its owner may take a shared task private.
- A project's visibility is changed by its owner only. The change cascades to its tasks, history, notes, Claude items and trash.
- New project ids are slugs, checked across all organizations.
- Names are unique per organization.

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
- Note files are stored under `notes/<orgId>/`. The upload and file routes refuse other organizations' paths. Files from before (`notes/<name>`) belong to the first organization.

**Migration.** Run `scripts/migrate-ownership.mjs --db <name>`. It is a dry run that prints counts only; `--apply` writes. `--copy-to <new db>` copies the database first and migrates the copy, never writing to the source. It is idempotent. It does the following:
- assigns everything to the first organization and its owner;
- makes projects `org`;
- makes tasks and notes with no project private;
- converts actors;
- turns `waitingOnOm` into `waitingText`/`waitingOn`;
- rebuilds `task:`/`claudeItems:` counters from the highest ref;
- moves settings to `<area>:<userId>` / `discord:<orgId>`;
- stamps `orgId` on the authMigration notice.

Order on deploy: deploy the code, then run the migration at once. Until it runs, old documents are invisible because they have no `orgId`.

## Audit summary (2026-10-19)

- All 26 collections have no owner or organization field; numbers, project names and Claude item numbers are globally unique.
- Sign-in is one shared password; the cookie carries no user. `MCP_TOKEN` is a full-access global key; `wos_` and `wkr_` keys have no owner.
- About 15 server actions and 3 API routes rely only on the proxy; the rest check "signed in", never who.
- "Om" is load-bearing in 26 files (MCP instructions, policy, claude-items, alerts, Discord). Timezone and quiet hours are fixed.
- Om's timetable, modes, Fiverr routine and weekly review fields are code.
- CPU: the live version refreshed the Claude page every 10 s and re-rendered 7 pages after each refresh (about 23,000 renders a day). Still present: worker polling (2,880 to 8,640 calls a day, 8 to 16 queries each), a database read for the session on almost every request, heavy page queries without projections.
