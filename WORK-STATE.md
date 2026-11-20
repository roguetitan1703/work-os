Copy of the Work OS state, version 124. WORK-STATE.md is a copy of the State, written by the Work OS hook; never edit it. Change the State in Work OS (https://work.delpat.in/projects/work-os).

# Work state: Work OS

## Now
- Ship Harness end to end (#276, docs/flows/agent-system.md): R6 and R7 are live. Now: the Fable tool-calling review and its fixes, H16 measuring until about 3 Dec, then H17. Per part: Opus plans, Sonnet builds in its slot, Opus reviews, dev, tests; production per release with Om's go.

## Next
1. UI revamp so the purpose of the work always shows first (Om 18 Nov): design note b961e1600e (purpose header A, then Today B, then chips C; 5 phases). Phase 1 built on builder-s 32374a5 (flow-ui-p1 52; looked at 390/1280 light and dark): merge with R8.
2. Need answers reach whoever holds the work now (design e62ea121eb; builder S2 Sonnet building on builder-s2): a Need asked by a session that is off is delivered to the project's Now holder or the session that picked up its handover, and start_work lists answered Needs since the last lead's session; withdraw_need on an answered or closed Need says so with the answer and time. Fold into the lanes design (note after 2afd68cb00).
3. R8 (note 954f4550f8): batch A, the stopgap (ab06462) and run keys for dispatched runs (2cfc999) merged in wos-int branch r8-int; tsc, words and worker 424 pass. Re-reviews: Reopen all and resume closed; builder A fixing the Open in VS Code HIGH; then a final check, full e2e, dev, and ask Om.
4. Discord setup with Om signed in: Interactions URL, Register commands, pick the team digest channel, bot Send Messages on the team channel. — waits on Om signed in to Discord
5. Use steps 1-3 for a week on cutroom and Work OS, then step 4 (Assign to anyone, Continue, lid-open resume; design in docs/flows/step-4.md, four questions wait on Om). — waits on a week of use (H16, about 3 Dec)

## Later
- Off-box backups to R2 (bucket, token, age key) — waits on Om.
- Cut / Freeze list from PRODUCT.md and the dead code it frees — waits on Om's approval.
- An "Approve and send" button for mail an agent drafted to an outside address — waits on the mail tools being used.
- Post new Mailloom reports in #mailloom too — waits on Om's yes.
- import_state cuts lines over 500 characters: the overflow becomes a Later line, a text line above Now became a Later line, and MCP has no op to edit or delete a line (cutroom's import 18 Nov left two fragment lines in Later) — waits on a fix slot (keep long lines whole or cut on a sentence; skip header text; an edit/remove op)
- Messages between two sessions of the same person stay unread forever (each sees the other as "me", so inbox never marks them seen); seen by Om's chat test 18 Nov. Fix with the live-sessions work (mark seen per session, not per person). — waits on the live-sessions design (Fable review, then builder B)
- The 169 Later lines that lived only in WORK-STATE.md moved to docs/later-backlog-18-nov.md (replaces the 'full long list stays in WORK-STATE.md' line). — waits on a Declutter pass with Om's go
- Set up Akash's PC with docs/setup-pc.md (MCP connection, worker, `node worker.mjs hooks install`, key). — waits on Akash and Om together
- ask's cap of 5 open Needs per person counts every project from the same key: 5 Grant Leads Needs blocked a Work OS ask (18 Nov). Count per project, or per asking session. — waits on Om's view on the cap
- Digest Since yesterday reads the State log, tasks done and Needs itself; switch it to the Activity feed now that it holds everything (design note a8f0fe709a, rule 4). — waits on the batch shipping
- next build under an agent stops once with a SecurityFatalError upgrade nudge (16.4.6, the latest stable); find the advisory and its target before upgrading. — waits on R1 fixes
- done_next on a Next line naming a parent task with open subtasks sends the parent to review (19 Nov: finishing the R2 line opened review Need #10 for #276, withdrawn). Fix: don't send a task to review while it has open subtasks; also, a release line should name its part (#282) not the parent. — waits on a fix slot (small, with H8 or the next batch)
- Claude > Now sessions table at 1280: columns don't line up row to row (project, machine, state start at different x per row); 'since HH:MM' beside 'N minutes ago' on Workers reads as redundant. — waits on the UI revamp (Next 3)
- Dispatched-run Orders block: a resumed dispatched session isn't marked WORK_OS_DISPATCHED, and a hijacked run could call /api/mcp from the shell with WORK_OS_KEY. A server-side marker would need dispatched runs on their own key. — waits on H15 (dispatcher on the Harness)
- Dispatcher cap: e9fd820 ranks claims by claimedAt, which is stamped before the write, so two claims written in the opposite order to their timestamps can still each pass. Make it airtight with an atomic per-person slot counter (inc when claiming, dec when a run ends). — waits on R5 out
- H8 attended rule: the automated-prompt list in worker/hook-user-prompt.mjs (AUTOMATED_PROMPT) must be kept current; a new Claude Code wrapper would count as typed until added. — waits on a new automated prompt kind appearing
- worker test hook-h7 #117 'wait: a wake keeps the ids' fails now and then under the full parallel worker run (passes alone; seen 4+ times on 19 Nov in slots A, B, S). Timing in the test, not the code (not checked). — waits on a fix slot
- Idle wait ends ~1 h after a stop (hook timeout 3600 s): a session idle longer gets no messages and no later nudges until its next turn. Consider re-arming the wait (a fresh wait after a timeout) if sessions idle for hours should still be reached. — waits on nudges used for a week
- Dark mode at 390 (Claude › Now, seen 20 Nov in the H11 step 8 screenshots): the selected pill of a segmented control (Now; All sessions) is light grey with white text, hard to read; Start Claude reads as disabled when no worker is linked. Not caused by the Claude items removal. — waits on the UI revamp (Next 3)
- oauth e2e 'settings: phone: no sideways scroll' fails some runs at 390, each time on a different row, with docScroll and mainScroll false: the page never scrolls. Likely measured while the panel slides in. The test should wait for the animation. fails about 3 runs in 4 on the Add passkey row (Settings › Account › Security at 390). Cause not found: it is not inside a closed details, and 740cd1f's helper change is not the fix. Check by eye at 390, and check the panel slide-in timing.
- flow-dc1 'a review Need gets no buttons in its DM' fails about 2 runs in 3: the test inserts the review Need's alert after the asks, so the DM sometimes misses the batch. Test race; the alerts code didn't change in R7.
- The SIGTERM fix does not work: on R7 (59cb0edb5693) a systemctl restart still waits the full 30 s stop-sigterm timeout, then SIGKILL (journal 20 Nov 01:44 IST). Something keeps next-server open (SSE /live streams, the wait route, or Mongo). Each deploy is about 30 s down.
- Declutter cache still counted "7 open Claude items" on 20 Nov after the migration moved them all: the cached daily reasons are not refreshed after a migration or apply. — waits on a fix slot (small)
- Run keys, small leftovers from the final re-check (09277d5): the release update has no state guard (run-keys.ts:73); a worker crash mid Reopen-all leaves rows in starting with live keys until 24 h; the worker trusts the server on a resume job with no dispatched flag. — waits on a fix slot (small)
- The idle nudge says "add waits_on (save_state edit_line)", but edit_line silently ignores waits_on (20 Nov): an agent following the nudge changes nothing. Make edit_line take waits_on, or fix the nudge text. Unknown op fields are stripped with no error. — waits on R8 batch B or H17
<!-- work-os-copy sha1:d283d4a6b4549245b109dcf42e03cb3d2371dbfd -->
