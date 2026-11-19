Copy of the Work OS state, version 100. WORK-STATE.md is a copy of the State, written by the Work OS hook; never edit it. Change the State in Work OS (https://work.delpat.in/projects/work-os).

# Work state: Work OS

## Now
- Ship Harness end to end (#276, docs/flows/agent-system.md): parts H0-H16 as subtasks #277-#293. Per part: Opus writes the implementation plan, Sonnet builds in its slot, Opus reviews, dev, tests; production per release with Om's go. Stop and ask Om on drift or duplication.

## Next
1. Discord setup with Om signed in: Interactions URL, Register commands, pick the team digest channel, bot Send Messages on the team channel.
2. Use steps 1-3 for a week on cutroom and Work OS, then step 4 (Assign to anyone, Continue, lid-open resume; design in docs/flows/step-4.md, four questions wait on Om).
3. UI revamp so the purpose of the work always shows first (Om 18 Nov): design after the agent-system review, then build.
4. Harness R3 = H6 (session state from hooks): steps 1-4 on dev 3caa047 (security-reviewed, fixes re-checked); steps 5-6 (UI, docs, What's new, budgets) building in slot A; then full e2e of dev, release R3, step 7 (refresh hooks on Om's PC, hand check in the desktop app and VS Code). Then H7 (plan 6dfdb98f4f) per #276. (#283)
5. H8 release waits on Om's answer to Need #11 (release yes always a tap, or chat yes enough). Built in slot B with the default. (#285) — waits on Om (Need #11)
6. Before R5, harden H9 fix 2: dispatched runs share the wos_ key and the label/session check is agent-controlled, so a hijacked run could pass Om's session id and edit Orders. Fix: worker launches dispatched claude with WORK_OS_DISPATCHED=<ref>; the PreToolUse hook refuses write_note/propose_order on Orders pages in such runs; server check stays as a second layer. Next free slot. (#286)
7. R6 = session identity (note 2afd68cb00; builder-b ecc8d8a, steps 1-7). Opus security review 19 Nov: no high; slot B fixing seen-message read bypass, reply note, PID reuse, leftover 'inbox' text, fix script scope, oauth 'chat' word check. Then merge dev, full e2e, release on Om's chat yes, reinstall hooks, fix-message-word on production (dry run first). (note 2afd68cb00): Opus plan, then build in slot B, Opus security review, then into R5 or right after it; reinstall hooks on the PCs.
8. Need answers reach whoever holds the work now: a Need asked by a session that is off is delivered to the project's Now holder or the session that picked up its handover, and start_work lists answered Needs since the last lead's session; withdraw_need on an answered or closed Need says so with the answer and time. Fold into the lanes design (note after 2afd68cb00).
9. Nudges (Om 19 Nov, note ce434ed759): idle 20 min with Next work not waiting on anyone wakes the holder through the idle wait (backoff 1/2/4 h, 4 a day, not when the person typed in the last 20 min); Declutter-due nudge to the Now holder once a day at turn end. Build in R7 after lanes step 1.
10. Claude items migration on production: the dry run found 14 open items (AKAR 5 -> 2 tasks + 3 Later, PMS 2 -> 2 tasks, Work OS 7 -> 7 tasks). R7 hides the Claude items page, so they are invisible until moved. Apply with --apply. — waits on Om's yes

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
- next build under an agent stops once with a SecurityFatalError upgrade nudge (16.4.6, the latest stable); find the advisory and its target before upgrading. — waits on R1 fixes
- done_next on a Next line naming a parent task with open subtasks sends the parent to review (19 Nov: finishing the R2 line opened review Need #10 for #276, withdrawn). Fix: don't send a task to review while it has open subtasks; also, a release line should name its part (#282) not the parent. — waits on a fix slot (small, with H8 or the next batch)
- Claude > Now sessions table at 1280: columns don't line up row to row (project, machine, state start at different x per row); 'since HH:MM' beside 'N minutes ago' on Workers reads as redundant. — waits on the UI revamp (Next 3)
- Dispatched-run Orders block: a resumed dispatched session isn't marked WORK_OS_DISPATCHED, and a hijacked run could call /api/mcp from the shell with WORK_OS_KEY. A server-side marker would need dispatched runs on their own key. — waits on H15 (dispatcher on the Harness)
- flow-hooks crashed 3 times in slot S only (wos-s, ports 27284/3284/4404) with ECONNRESET at its start_work link call (flow-hooks.mjs:84); 28/0 in slot A on the same commits. Something about that slot or the load, not the code; look if it repeats. — waits on it repeating in a full e2e
- Dispatcher cap: e9fd820 ranks claims by claimedAt, which is stamped before the write, so two claims written in the opposite order to their timestamps can still each pass. Make it airtight with an atomic per-person slot counter (inc when claiming, dec when a run ends). — waits on R5 out
- H8 attended rule: the automated-prompt list in worker/hook-user-prompt.mjs (AUTOMATED_PROMPT) must be kept current; a new Claude Code wrapper would count as typed until added. — waits on a new automated prompt kind appearing
- work-os.service stop times out (30 s, then SIGKILL) on most deploys: 10 times in 3 days. Likely the hooks' long-poll waits (/api/agent/wait up to 1 h) hold the server open; close waits on SIGTERM. — waits on a fix slot (small, with R7)
- worker test hook-h7 #117 'wait: a wake keeps the ids' fails now and then under the full parallel worker run (passes alone; seen 4+ times on 19 Nov in slots A, B, S). Timing in the test, not the code (not checked). — waits on a fix slot
- Idle wait ends ~1 h after a stop (hook timeout 3600 s): a session idle longer gets no messages and no later nudges until its next turn. Consider re-arming the wait (a fresh wait after a timeout) if sessions idle for hours should still be reached. — waits on nudges used for a week
- Dark mode at 390 (Claude › Now, seen 20 Nov in the H11 step 8 screenshots): the selected pill of a segmented control (Now; All sessions) is light grey with white text, hard to read; Start Claude reads as disabled when no worker is linked. Not caused by the Claude items removal. — waits on the UI revamp (Next 3)
- Notes search fixed on dev d5b1454 (desktop Filter sent the Select's empty marker as project/shelf); ships with R7. (19 Nov). Production data and the server regex are fine ("orders" matches 24 notes). Builder S is reproducing it in wos-s with a new flow-notes-search suite.
- oauth e2e 'settings: phone: no sideways scroll' fails some runs at 390, each time on a different row, with docScroll and mainScroll false: the page never scrolls. Likely measured while the panel slides in. The test should wait for the animation. fails about 3 runs in 4 on the Add passkey row (Settings › Account › Security at 390). Cause not found: it is not inside a closed details, and 740cd1f's helper change is not the fix. Check by eye at 390, and check the panel slide-in timing.
- flow-dc1 'a review Need gets no buttons in its DM' fails about 2 runs in 3: the test inserts the review Need's alert after the asks, so the DM sometimes misses the batch. Test race; the alerts code didn't change in R7.
- The SIGTERM fix does not work: on R7 (59cb0edb5693) a systemctl restart still waits the full 30 s stop-sigterm timeout, then SIGKILL (journal 20 Nov 01:44 IST). Something keeps next-server open (SSE /live streams, the wait route, or Mongo). Each deploy is about 30 s down.
<!-- work-os-copy sha1:a6196e75aa04b00d0fbef95c202d6d03daf47d93 -->
