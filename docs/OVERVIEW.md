# Work OS: overview

Read this first. Each line below says what a thing is and where the detail lives: **H3** means a section of `docs/HANDOVER.md` (the reference, one section per feature), a path means a flow or ops doc. The map of all docs is `docs/README.md`.

## What it is for

Work OS is Delpat's one place for work: tasks, projects, notes, Needs, Discord and alerts, used by people on a laptop and a phone and by Claude (claude.ai, Claude Code on any PC, the cloud dispatcher) through one MCP connector. The aim: every agent works the same disciplined way, and Work OS is always the true, current picture of what is being done, so a person can see where everything stands and what waits on them (H1 top, H3).

## The words

A project's **State** is its Now (one goal), Next, Later (found, not chased), Decisions and Where; **Parked** holds ideas set aside. A **task** (#12) is a deliverable someone tracks. A **Need** is one question to one person. The **Orders** are the standing rules. A **handover** is the note a session leaves for the next. Use only these words (H3 "Words"; `npm run check:words` enforces them in agent-facing text).

## The people's app

- **Today** (laptop and phone): Needs for you, Projects now (each project's goal and next step), your schedule, tasks due, What's new. H8.
- **Tasks and projects:** priorities, due dates, repeats, assignees, subtasks, modes, shared and private projects; a task says why it exists and where it sits in the plan. H2; subtasks in H2 (Subtasks).
- **Project page:** opens on its Now, who holds it, sessions working on it, Needs, the State card (Next, Later, Parked, Decisions), Info (code folders, context warning, Discord bug channel). H2, H3, H8.
- **Notes:** Notion-style pages on shelves, share link, the organization's Orders at the top. H5.
- **Needs:** one line each with a recommended answer; answer in the app, on Discord or by typing. H3, H8.
- **Batch changes, Review, Trash:** apply many edits at once, see what finished, restore deleted work. H4.
- **One search** (Ctrl+K or /): tasks, projects and their State lines, notes, sessions, Needs, folders, settings. H8.
- **Alerts and digests:** inbox bell, phone push, Discord DM, email; due and overdue alerts; the 09:00 morning digest and the Monday numbers. H7.
- **Phone app (PWA):** tab bar Today, Projects, +, Needs, Claude; Menu is one list; pull to refresh. H8.
- **Settings and login:** profile, connections, notifications, Usage; passwords, passkeys, invitations. H9, H10; `docs/ops/auth.md`.
- **What's new:** one entry per user-facing change, `lib/whats-new.ts`. H8.

## A Claude session, end to end

1. **Start.** A Claude Code session opens in a folder. The hook (installed by the worker) signs in with the PC's device key, finds the project the folder belongs to (an unfiled folder asks once) and calls `start_work`. H3 "Claude Code hooks"; `docs/flows/agent-system.md`.
2. **Brief.** The answer is the Orders, the State, Where, open Needs and messages, any handover to pick up, and the name to set. The session works from that, never from memory. H3.
3. **One identity.** A Claude session is one row per person, computer and Claude session, through restart, `/clear` and a move to another project; tokens renew. H3 "Session identity".
4. **Work.** `set_doing` names its task; its lane (branch, slot, task, last result) shows on the project; only the session holding Now records the State, at each merge. `save_state` writes the State; WORK-STATE.md is only a copy the hook writes. H3 "Lanes".
5. **Messages.** `send_message` goes to a session of yours or to a person's lead session, woken if idle, with a frame saying who sent it and what it may ask; read with `message_status`. `docs/flows/session-messaging.md`; H3.
6. **Needs.** `ask` only when the person is away or the question is for someone else; while they are in the chat, ask there and record a Decision. A push to production needs a release Need (Yes 1 h or 24 h). H3 "Messages", "release Need"; `docs/flows/enforcement.md`.
7. **Feedback.** `feedback` tells Work OS what got in the way; refusals are plain and say what to do; the third same refusal in 30 minutes suggests feedback. H3.
8. **End.** `end_work` saves the State and leaves a handover; the next session (or `/transfer`) picks it up, and the old session's Needs, messages and holds move to it. H3 "end_work".

## The Claude page

- **Sessions:** one list of every session (live first, then Idle, Quiet, Waiting on you, finished today), with its project, task, computer, account and last line; one button per row: Answer, Message or Resume. H8 "Sessions".
- **Set up:** computers, the worker, hooks, API keys, signed-in apps. H3, H8; `docs/ops/setup-pc.md`, `docs/ops/launcher.md`.
- **Claude's tasks:** give a task to Claude and the cloud **dispatcher** starts a session on a PC, restarts once, and reports a result. H3; `docs/ops/dispatcher.md`.
- **Context warning:** a per-project size at which Claude is told to write a code-map note and stop. H3.

## The worker and hooks

The worker is a small program on each PC. It reports sessions and folders, starts and resumes Claude Code, clones repos, installs the hooks and the `/transfer` and `/declutter` skills, reads usage counts from Claude's transcripts, and updates itself from releases signed with Delpat's key. Hooks gate work: refuse hand edits of WORK-STATE.md, refuse production pushes without a release Need, deliver messages and Orders changes into a running session, and report its true state. H3 "Claude Code hooks"; `worker/README.md`; `docs/ops/launcher.md`.

## Keeping a project tidy

- **Declutter:** when a project grows, Work OS proposes archiving old Later lines and duplicate notes; the project's owner approves on one Need; nothing is deleted. H3 "Declutter".
- **Parked and Decisions:** dated lists with no limit, outside the brief. H3.
- **Orders:** the standing rules in three layers (organization, project, person), with versions, a Changes list and Undo; a person's Claude may fix them with a reason. H3 "Orders"; H5.
- **Usage:** the worker records token counts per session (never text); the `usage` tool shows an estimated share; the page is not built yet. H3; `docs/ops/launcher.md` "Usage".

## Discord, mail and intake

- **Discord:** read channels, slash commands, task posts, a bug channel per project, the track emoji, Connect Discord, and Discord alerts. H6.
- **Mail:** Claude's `mail_*` tools through each person's own Mailloom key; mail outside the caller's own mail domain is drafted and a person sends it; inside the own domain the agent sends (up to 100 an hour). H3; `docs/flows/mail-connect.md`.
- **Mailloom intake:** problem reports become tasks in one project; update notices go to one Discord channel. H3.
- **Calendar and schedule:** `docs/ops/calendar.md`.

## Running it

- **Hosting:** an EC2 box, Caddy, systemd, MongoDB Atlas; `master` deploys at 03:00 IST; work goes to `dev` first. `docs/ops/hosting.md`.
- **Many people:** organizations, shared and private, scoped data access. `docs/ops/multi-user.md`; H12.
- **Request log and CPU:** `docs/ops/usage-log.md`, `docs/ops/cpu.md`.
- **Working on the code:** H12; the owned questions and their owners `docs/ARCHITECTURE.md`; `npm run check` before a merge; tests `tests/e2e/README.md`; the rules for UI are in `AGENTS.md`.
