Copy of the Work OS state, version 7. Edit it in Work OS (https://work.delpat.in/projects/work-os); this file is its copy.

# Work state: Work OS

## Now
- Make the steps 1-3 features visible and used (Needs, State, project messages, results and review, digest), and ship the 18 Nov batch.

## Next
1. Recurring tasks on the calendar: the next copy appears on the current copy's due date, done or not (builder B).
2. "What's new": a card on Today, a What's new page with a dot, and "New" badges for 14 days; a Needs page in the menu and sidebar; empty states that say what will appear (builder A).
3. Redesign the morning digest: Needs you with buttons, top 3 for today, one line per project since yesterday, agents running or stalled; not a task list.
4. Discord setup with Om signed in: Interactions URL, Register commands, pick the team digest channel, bot Send Messages on the team channel.
5. Use steps 1-3 for a week on cutroom and Work OS, then step 4 (Assign to anyone, Continue, lid-open resume; design in docs/flows/step-4.md, four questions wait on Om).
6. Activity shows everything that changed: State, notes, messages, Needs and projects next to tasks, read through the visibility rule, with a What filter, in Review › Activity, the project page, recent_activity and the summary (builder B after recurrence; security review before merge).
7. Live sessions and messaging design (docs/flows/session-messaging.md): global Work OS plugin with hooks for on/working/idle/waiting/off at zero tokens, a channel to push messages in, every session lives in a project (Lobby for strays), notes on fixed shelves with drift rules. Waits on Om's two notes answers, then a Fable review, then builder B.

## Later
- Off-box backups to R2 (bucket, token, age key) — waits on Om.
- Cut / Freeze list from PRODUCT.md and the dead code it frees — waits on Om's approval.
- An "Approve and send" button for mail an agent drafted to an outside address — waits on the mail tools being used.
- Post new Mailloom reports in #mailloom too — waits on Om's yes.
- e2e oauth phone overflow check flaky with the installed Chrome — waits on it showing on a real phone.
- The full long list stays in the repo's WORK-STATE.md Later section — waits on a cleanup pass.
- import_state cuts lines over 500 characters: the overflow becomes a Later line, a text line above Now became a Later line, and MCP has no op to edit or delete a line (cutroom's import 18 Nov left two fragment lines in Later) — waits on a fix slot (keep long lines whole or cut on a sentence; skip header text; an edit/remove op)
- Messages between two sessions of the same person stay unread forever (each sees the other as "me", so inbox never marks them seen); seen by Om's chat test 18 Nov. Fix with the live-sessions work (mark seen per session, not per person). — waits on the live-sessions design (Fable review, then builder B)
- The 169 Later lines that lived only in WORK-STATE.md moved to docs/later-backlog-18-nov.md (replaces the 'full long list stays in WORK-STATE.md' line). — waits on a Declutter pass with Om's go

## Decisions
- 2026-11-18: 18 Nov, Om: SSH is plain ubuntu login with host names workos and mailserver in ~/.ssh/config (key delpat_ed25519), from VS Code and the terminal; no separate agent user, no sudoers changes. (Om, chat)
- 2026-11-18: 18 Nov, Om: Mailloom intake keys set in /etc/work-os/env on the Work OS server (token copied server to server, never shown; project mailloom-f60ee666; channel #mailloom). Not restarted: they take effect when the intake build goes live. Bot already has Send Messages in #mailloom. (Om, chat)
- 2026-11-18: 18 Nov: build 865c699 live (Mailloom intake + Inbox Select). Intake checked end to end: test notice in #mailloom (204), test report became #274 in Mailloom (201). (Om, chat)
- 2026-11-18: 18 Nov, Om (after the Fable review of docs/flows/session-messaging.md): the folder a session starts in decides its project (git remote is information only); a session in an unknown folder sorts itself out (asks which project, uses its folder on this PC, links or creates it); message text is pushed into sessions with its frame, ship/money/credentials stay enforced server-side; duplicate notes are refused. Build order: hand check, per-session ids, plugin, idle wake; feedback and notes shelves after. (Om, chat)
- 2026-11-18: 18 Nov, Om: status lives in Work OS. WORK-STATE.md in the repo is a copy so the last State can be read when Work OS is down; agents never edit it. The Work OS hook writes and commits it after every save_state and refuses hand edits (installed on Om's PC 18 Nov; Akash's PC and cloud later). Fable review agreed (docs/flows/working-system-review.md): three exact blocks only, actions as Work OS tools (wrap_up, hand_over, declutter), propose_order, 40-line Orders. (Om, chat)
<!-- work-os-copy sha1:97d735ff1ffdcad997b839b1ca231aa5c3e5bdc4 -->
