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

## Audit summary (2026-10-19)

- All 26 collections have no owner or organization field; numbers, project names and Claude item numbers are globally unique.
- Sign-in is one shared password; the cookie carries no user. `MCP_TOKEN` is a full-access global key; `wos_` and `wkr_` keys have no owner.
- About 15 server actions and 3 API routes rely only on the proxy; the rest check "signed in", never who.
- "Om" is load-bearing in 26 files (MCP instructions, policy, claude-items, alerts, Discord). Timezone and quiet hours are fixed.
- Om's timetable, modes, Fiverr routine and weekly review fields are code.
- CPU: the live version refreshed the Claude page every 10 s and re-rendered 7 pages after each refresh (about 23,000 renders a day). Still present: worker polling (2,880 to 8,640 calls a day, 8 to 16 queries each), a database read for the session on almost every request, heavy page queries without projections.
