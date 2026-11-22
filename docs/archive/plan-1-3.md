> Record, 22 Nov 2026: design of 14 Nov. Slices 1 to 3 (State, Needs and results, the roster) are built and have since changed; what exists now is in `docs/HANDOVER.md`.

# Build plan: steps 1–3 (State and inbox, Needs and the digest, the roster)

Status: **plan, 15 Nov 2026.** Om asked for a significant part planned at once, reviewed independently, then built.
This covers the "first three to build" of docs/archive/product-14-nov.md section 8. Step 1's detail is in
[step-1.md](step-1.md); steps 2 and 3 are designed here. Each slice names the flows it serves (docs/archive/product-14-nov.md section 7).

What Om can do when all three land:
- close the laptop mid-work, start a fresh session anywhere, in any AI, and lose nothing;
- drop an idea or a message from any chat into a project, and the next session picks it up;
- see one list of what waits on him, answer from the phone or Discord, accept or send back an agent's work in the
  app (reviews release work, so they are not answered from Discord; nor is anything touching production, money or
  credentials);
- get one digest each morning, and the team one message;
- see who is working on what and where, and which projects could be running but aren't.

## How it is cut

Seven slices. Each one merges on its own, with its tests, and is usable the day it lands.

| Slice | What | Flows | Depends on | Class → builder |
|---|---|---|---|---|
| 1 | **State + Orders + `start_work` + presence + the "for you" line** | S1, S2, H1 | — | do → B (Sonnet) |
| 2 | **Personal digest** on today's data (due, overdue, quiet, finished runs, moved yesterday) | B4 (part) | — | do → S (Sonnet) |
| 3 | **Messages** (project inbox, trust word, apply/reject, decisions) | MS1–MS4 | 1 | do → B (Sonnet), security review |
| 4 | **Needs** (ask one person one thing; answer anywhere; the work sees it) | N1, N2, B1, B2, F2 (part) | 1 | think+do → A (Opus): trust and who may answer |
| 5 | **Results and review** (agents hand in; Accept / Send back) | R1, decision 4 | 4 | do → B (Sonnet), security review |
| 6 | **Digest complete + team digest + Discord buttons** | B4, DC1, B3 | 2, 4 | do → S (Sonnet) |
| 7 | **The roster** (workers, builders under orchestrators, heavy slots, idle with Next work) | W1, W3, S3 (screen line) | 1 | do → B (Sonnet) |

**Order and pairing** (at most two builders at a time): 1 ∥ 2, then 3 ∥ 4, then 5 ∥ 6, then 7. Slices 1 and 2 touch
different files (MCP + new collections vs. lib/alerts.ts), so they run side by side.

**Shared files in 1 ∥ 2:** both touch `lib/db.ts`, `tests/e2e/run.sh`, `tests/e2e/leak-audit.mjs` and
`tests/e2e/alerts-once.mjs`. Each builder keeps its edits there additive (new lines, no reordering), and slice 2
merges second and resolves.

**Every slice:** builder in its own worktree, test database and ports; tests in `tests/e2e/flow-<flow>.mjs` plus the
leak-audit entries; a security review subagent before merging anything touching keys, trust, who may answer, or
what a session is woken with; merge to master locally; deploy in batches (1+2, 3+4, 5+6, 7). Nothing reaches
origin/master before the live build matches it.

**Backups and batch 1:** State and Decisions become data that lives in Work OS. Batch 1 goes live with a nightly
`mongodump` on the box (kept 7 days) plus the WORK-STATE.md copy committed in each repo; the encrypted off-box backup
to R2 follows when Om gives the bucket, token and age key. That way batches don't pile up unpushed waiting on it.

**Real use between batches:** cutroom and Work OS import their WORK-STATE after batch 1 and run on it. The
"used for real before the next step" rule of section 8 is kept per batch, not per slice: building the next batch
starts while the previous one is in use, and a problem found in use goes first.

### Options weighed for the order
- **A. One step at a time, a week of use between (as section 8 says).** Safest; about 6–8 weeks for three steps.
- **B. Build all three, then use.** Fastest; but State, the brief and the "for you" line are the base everything
  else rests on, and a mistake there spreads into five slices.
- **C (recommended). Batches, with use running beside the next build.** The base (slice 1) is used for real while
  messages and Needs are built on it; a problem in use goes first. About 3–4 weeks for all three.

---

## Slice 1: State, Orders, `start_work`, presence, "for you"
As [step-1.md](step-1.md) sections 1, 2, 3 and 5, with two changes from its open questions taken as recommended
(the boilerplate note becomes the organisation Orders; anyone who can edit a project can add a Decision).

- New collections in the scoped door: `states` and `presence`, each stamped with its project's placement and added to
  the placement cascade, `takeOffLists` and project delete (docs/archive/step-1.md section 1).
- Tools: `start_work`, `save_state`, `import_state`, `get_state`. Every tool answer gains `forYou` (ids and counts)
  when the caller is a present session; `forYou` is a registry later slices add sources to.
- **Session identity:** presence keyed by session id if given, else key / OAuth client + project; a `forYouCursor`
  timestamp per row; writes at most once a minute; `presence` stays out of push-hint TOPICS (docs/archive/step-1.md section 5).
- **Orders:** the `orders` field; Orders bodies editable by a person in the app only.
- App: the State card on the project page and the phone's project screen (read and edit with versions).
- **Slice 1b (batch 1, builder S after slice 2):** the SessionStart and Stop hooks (docs/archive/step-1.md section 6).

## Slice 2: personal digest on today's data
Replaces the 09:00 `due_today` digest with the B4 personal digest, built only from data that exists today.
- Sections, in order: **what agents finished** (claude_finished / claude_stopped since the last digest), **due and
  overdue**, **gone quiet** (In Progress, no change for 2 working days), **moved yesterday** (one line per project,
  from activity). Needs and "idle with Next work" join in slice 6.
- One digest per person per day at their own hour: a new profile field `digestHour` (default 9) with a Settings
  control, and a new alert kind `digest` (with its toggle; a migration turns it on for whoever has `due_today` on).
  Claimed once a day by an `alertLog` key `digest:<date>`. Sent through the channels they have on (Discord DM, push
  that opens Today, inbox, mail where on). Quiet hours and "off" respected.
- **What it absorbs and what stays:** due_today, the morning's overdue and stalled go into the digest. A task that
  becomes due, overdue or quiet **after** the digest hour still alerts on the next 15-minute run, as today, so
  nothing goes silent until tomorrow. `due_tomorrow`, `never_started`, `unblocked`, `assigned`, `claude_finished`,
  `claude_stopped` and `claude_stuck` stay as they are.
- "What agents finished" reads `alertQueue` by `createdAt` since the last digest (those rows are already claimed as
  sent alerts).
- Test (B4 part), driven through the cron's `?at=`: seeded 1 finished run, 1 overdue, 1 quiet task → exactly one
  digest, those sections in order; a second run the same day sends nothing; a task made overdue after the digest
  hour alerts on its own.

## Slice 3: messages
As [step-1.md](step-1.md) section 4. New collection `messages`, stamped with the project's placement like `states`.
Every reader of the project can read its messages (no person-private messages). Tools `send_message`, `inbox`,
`message_status`, `reply`. Applying a `decision` adds it to State. The app's Inbox tab on the project page.
- Trust is set by the server from how the call came in, three values: `person` (the app; Discord later), `chat`
  (the claude.ai connector, which may be unattended), `agent` (keys). See docs/archive/step-1.md section 4.

## Slice 4: Needs (step 2)

**A Need is one ask to one person.** It replaces "waits on Om" in progress text, WORK-STATE lines and
PushNotifications.

| Field | What |
|---|---|
| `project`, `task?` | where it belongs; a Need with no task belongs to the project's State |
| `to` | one person (user id). A client wait is addressed to whoever chases the client |
| `from` | person or agent, session label, `word` (as messages) |
| `kind` | `decide` (pick an option), `approve` (yes / no), `review` (slice 5), `do` (a hand step: "run sudo work-os-update"), `chase` (someone outside) |
| `ask` | plain words, ≤ 500 characters |
| `example` | a real example, ≤ 1,000 |
| `options` | 2–4 `{ id, label, means }`; the first is the recommendation. `approve` has yes / no; `do` has done / can't |
| `status` | open → answered, or withdrawn, or replaced |
| `answer` | `{ option, text?, by, via (app / phone / discord / chat), at }` |

- `appOnly` (true for anything touching production, money or credentials, docs/archive/product-14-nov.md section 9): answered in the
  app only, never from Discord.
- **Tools:** `ask(project, to, kind, ask, example?, options?, task?)`; `needs(project? | to: me)`; `withdraw_need(id)`.
  **There is no MCP tool to answer a Need.** The claude.ai connector can't prove a person is present (it also serves
  cloud and scheduled runs), so answers come only from the app, the phone, or the addressed person's own Discord
  button. A chat that's asked gets a link to the Need.
- **Limits:** `to` must be someone who can read the project; at most 5 open Needs from one asker to one person; the
  ask reaches the addressee labelled `writtenBy`.
- **One at a time per kind and task:** a second open Need of the same kind on the same task replaces the first.
- **An `agent`-word message to an unattended session** becomes one Need to the session's person (MS3), and changes
  nothing else.
- **Measured from day one:** each Need records how long it waited; each review records its outcome (accepted first
  time or sent back). Step 10's scorecard reads them.
- This is the trust line of the whole design, so slice 4 goes to builder A with a review.
- **The task shows it:** a task with an open Need shows "Needs Om: <ask>" in place of its percent, everywhere a task
  is listed. A task waiting on a Need is never "quiet" (F2).
- **One alert** per Need (new kind `need`, sent at once, like `assigned`): push that opens the Need, Discord DM, inbox.
- **The work sees the answer:** the asking session's next tool answer carries it in `forYou` ("your Need #N was
  answered: option B"); the next `start_work` on that project lists answered Needs first. On a machine with the
  daemon, an idle session is not woken in this slice (that is step 4).
- **In the app:** "Needs you" at the top of Today (desktop and phone), each with its options as buttons and a text
  box; a Needs tab per project; State's Next lines show "waits on Om" from open Needs (docs/archive/step-1.md `waitsOn`).
- **Moving the hidden waits in:** a one-off chore (Haiku, else Sonnet): read every project's WORK-STATE "waits on
  Om" lines and tasks' `waiting_on_om` text, propose Needs to Om as one list, create the ones he keeps.
- Test N1: a Need shows under "Needs you" in `start_work` and on Today, one alert, a second of the same kind replaces
  the first. N2: answering from the app puts it in the asker's `forYou` once and first in the next brief. Access:
  an agent key calling `answer_need` is refused; a member who can't see the project can't see or answer it.

## Slice 5: results and review (step 2)
- **`hand_in(task, result)`**: `changed`, `checked` (how), `rating` (works / awkward / doesn't work), `where` (links:
  PR, preview, note, Delpat OS), `left` (lines). Work OS links; it stores no files.
- **Decision 4, enforced in the data layer, not the tool:** Done is reachable today through `update_task`,
  `log_progress`, the `apply_changes` op, `completeTask` and the dispatcher's finish path. The gate sits in
  `updateTask` / `completeTask` on the actor: an agent closing a task whose result `kind` is `code`, `data` or
  `client` gets a `review` Need to the task's owner instead of Done. `check` and `report` finish by themselves.
- **The kind:** a new task field `resultKind`, set by whoever plans the task or by `hand_in`. A task with none, closed
  by an agent: `report` (so existing dispatcher runs keep finishing as today), until the planner sets kinds.
- **One alert, not two:** for a dispatched task that goes to review, the review Need's alert replaces
  `claude_finished`.
- **Review buttons:** Accept (Done) · Send back with a line (back to In Progress; the line is first in the next
  brief for that task) · Accept and file what is left (Done, plus one task per `left` line).
- **The digest's "finished, to review"** reads open review Needs (slice 6).
- Test R1: an agent's `complete_task` on code work gives a review Need, not Done; Send back re-queues with the line
  first in the brief; a person's `complete_task` still finishes directly.

## Slice 6: digest complete, team digest, Discord buttons (step 2)
- The personal digest gains **Needs you** (first, with buttons in Discord) and **idle with Next work** (projects
  whose State has unblocked Next lines and no present session; private projects only for their readers).
- **Team digest:** one message a day in a team Discord channel (org setting; the bot posts with its token):
  per shared project, done yesterday, Now, and who it waits on. Private and chosen-people projects are left out.
- **Discord buttons on Needs:** the DM carries the options as buttons (`wo:need:<id>:<option>`, inside the existing
  `^wo:(...)` pattern so entry-points.mjs audits it). A DM interaction has no `guild_id` and carries `user`, not
  `member`, and today's route refuses it (app/api/discord/interactions/route.ts); the new path resolves the
  organization and the person **from the Need** (the addressed person's linked `discordId` must equal
  `i.user.id`), and the answer is taken once, atomically. `appOnly` Needs get no buttons, only a link. This works when
  Om sets the Discord Interactions URL (waiting on him); until then the DM links to the app.
- **B3 proven live:** one Send test per channel from Settings (waiting on Om) before the digest goes on.
- Test: seeded 1 Need, 1 finished run, 1 overdue, 1 quiet → one digest with sections in order; a private project
  never appears in the team message; a stub interaction from another member's Discord id is refused.

## Slice 7: the roster (step 3)
Presence (slice 1) grows into **workers**.
- **A worker** = a session: `actsFor`, `ai` (from the key or OAuth client name), `model` (reported), `account`
  (reported label), `machine` (device id when the daemon knows it, else the reported name), `project`, `branch`,
  `doing` (task), `parent` (the orchestrator's session, for builders), `lastSeen`.
- **State is computed, not typed:** working (seen in 10 min), waiting on a person (has an open Need), idle with Next
  work, gone (not seen in 30 min and, where the daemon reports, its process is gone).
- **Tools:** `start_work` gains `model`, `account`, `parent`, `slot`; `set_doing(task)`; `slot(machine, 'heavy')`
  acquire / release with a 30-minute lease and a cap per machine (default 2), held across all sessions on it.
- **Screen:** a Workers tab on the Claude page (desktop and phone): one row per worker, builders indented under their
  orchestrator, and at the top **"could be running and isn't"**: projects with unblocked Next work and no live
  worker. The same line goes into the digest (slice 6) and the project page.
- **Accounts:** the roster shows workers per account and model. A usage alert waits on a way to read usage (later).
- Test W1: a worker that stops calling shows as gone within one cycle and its task as unheld; builders show under
  their orchestrator. W3: a third heavy-slot request on a cap of 2 waits until one is released or its lease ends.

## Not in steps 1–3
Waking an idle session with the daemon, Continue from the phone and lid-open resume (step 4); recipes and ship
(step 5); a second machine (step 6); the dispatcher on Discord (step 7). The hooks of docs/archive/step-1.md section 6 come after
slice 1 is in real use.

## Risks the plan carries
- **Session identity rests on agents passing an id.** If a client drops it, presence and "for you" fall back to
  per key and project. The header path is the fix where clients support it.
- **`chat` is not proof of a person.** The claude.ai connector also serves unattended runs, so nothing an agent can
  call answers a Need, sets Orders or approves. The step 7 dispatcher needs its own key kind before it acts.
- **The digest replaces alerts people get today.** Folding the morning's overdue and stalled into it changes what
  arrives; one line in the first digest says so.
- **Unlabelled teammate text in list tools** (WORK-STATE Later) stays; the brief and `forYou` carry ids and labels,
  so the new paths don't widen it.

## Review (Fable, 15 Nov), and what changed
Verdict: go with changes. Taken in full: `chat` as a third trust word and no MCP tool to answer a Need; the new
collections stamped with placement and added to the cascade; the Done gate in the data layer; the Discord DM path
and `appOnly`; Orders bodies app-only and labels on others' Orders and Decisions; batch 1 live on an on-box nightly
dump; presence keyed with a cursor and no body text in `forYou`; only the reordering ops versioned; tests under
`tests/e2e/flow-*`; the digest's absorb-and-keep list; Need limits; hooks and a save nudge in batch 1; client names as
the worker's AI; Need wait time and review outcome recorded from day one.
