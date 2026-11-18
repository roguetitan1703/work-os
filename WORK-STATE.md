Copy of the Work OS state, version 19. Edit it in Work OS (https://work.delpat.in/projects/work-os); this file is its copy.

# Work state: Work OS

## Now
- Make the steps 1-3 features visible and used (Needs, State, project messages, results and review, digest), and ship the 18 Nov batch.

## Next
1. Discord setup with Om signed in: Interactions URL, Register commands, pick the team digest channel, bot Send Messages on the team channel.
2. Use steps 1-3 for a week on cutroom and Work OS, then step 4 (Assign to anyone, Continue, lid-open resume; design in docs/flows/step-4.md, four questions wait on Om).
3. Live sessions and messaging design (docs/flows/session-messaging.md): global Work OS plugin with hooks for on/working/idle/waiting/off at zero tokens, a channel to push messages in, every session lives in a project (Lobby for strays), notes on fixed shelves with drift rules. Waits on Om's two notes answers, then a Fable review, then builder B.
4. UI revamp so the purpose of the work always shows first (Om 18 Nov): design after the agent-system review, then build.
5. Ship the 18-19 Nov batch, merged on dev locally (a650d95, not pushed): recurrence, What's new + Needs, State edit_line, worker installs hooks, hook device-key sign-in, digest redesign, Activity shows everything (each security-reviewed and re-checked). Left: full e2e + build on dev, UI by eye at 390/1280 light/dark, push dev, merge to master with Om's go. — waits on C: freed to 15 GB (Claude app VM image 9.9 GB is the only item big enough)

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
- Set up Akash's PC with docs/setup-pc.md (MCP connection, worker, `node worker.mjs hooks install`, key). — waits on Akash and Om together
- Sub-agent State lanes: orchestrator keeps Now/Next; each builder or side session gets a lane line; stable slots keep theirs, strays are archived when gone; the turn-end hook asks workers to update their lane, not Next (note 'Sub-agent State: lanes', Om 18 Nov). — waits on per-session ids (builder A), then a short design and builder B
- ask's cap of 5 open Needs per person counts every project from the same key: 5 Grant Leads Needs blocked a Work OS ask (18 Nov). Count per project, or per asking session. — waits on Om's view on the cap
- Digest Since yesterday reads the State log, tasks done and Needs itself; switch it to the Activity feed now that it holds everything (design note a8f0fe709a, rule 4). — waits on the batch shipping

## Decisions
- 2026-11-18: 18 Nov, Om: SSH is plain ubuntu login with host names workos and mailserver in ~/.ssh/config (key delpat_ed25519), from VS Code and the terminal; no separate agent user, no sudoers changes. (Om, chat)
- 2026-11-18: 18 Nov, Om: Mailloom intake keys set in /etc/work-os/env on the Work OS server (token copied server to server, never shown; project mailloom-f60ee666; channel #mailloom). Not restarted: they take effect when the intake build goes live. Bot already has Send Messages in #mailloom. (Om, chat)
- 2026-11-18: 18 Nov: build 865c699 live (Mailloom intake + Inbox Select). Intake checked end to end: test notice in #mailloom (204), test report became #274 in Mailloom (201). (Om, chat)
- 2026-11-18: 18 Nov, Om (after the Fable review of docs/flows/session-messaging.md): the folder a session starts in decides its project (git remote is information only); a session in an unknown folder sorts itself out (asks which project, uses its folder on this PC, links or creates it); message text is pushed into sessions with its frame, ship/money/credentials stay enforced server-side; duplicate notes are refused. Build order: hand check, per-session ids, plugin, idle wake; feedback and notes shelves after. (Om, chat)
- 2026-11-18: 18 Nov, Om: status lives in Work OS. WORK-STATE.md in the repo is a copy so the last State can be read when Work OS is down; agents never edit it. The Work OS hook writes and commits it after every save_state and refuses hand edits (installed on Om's PC 18 Nov; Akash's PC and cloud later). Fable review agreed (docs/flows/working-system-review.md): three exact blocks only, actions as Work OS tools (wrap_up, hand_over, declutter), propose_order, 40-line Orders. (Om, chat)
- 2026-11-18: 18 Nov, Om: Claude items retired from the instructions (work list = State and tasks). Global Claude Code settings on Om's PC: the 4 Work OS hooks, WORK_OS_KEY made from the database by scripts/make-key.mjs (key "Hooks · Victus-Knight"), Work OS reads and own-work writes allowed, .env.test.local readable, ~/.claude.json edits denied, two auto-mode notes; project-specific rules (grant-leads Supabase, Vercel) stay out. Recorded in docs/setup-pc.md. (Om, chat)

## Where
- Victus-Knight: dev a650d95 clean (2026-11-18 18:43)
<!-- work-os-copy sha1:b58a3cf1a1bb4a4df81ca37aa4fbe084e4bc1c99 -->
