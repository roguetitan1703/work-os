# Harness: agents and Work OS, one design (18 Nov 2026)

"Harness" is the name for this plan (Om, 19 Nov): the hooks, rules, State, Needs, transfer and actions that make every
agent work the same way through Work OS. Its parts ship in releases (R1 = the 18-19 Nov batch).

This doc replaces three overlapping designs: session-messaging.md (live sessions and messaging), enforcement.md (rules
and hooks) and working-system-review.md (Fable's review). Those stay as background; this one is what gets built.
Status: draft for a Fable review, then Om.

## 0. The goal
Every agent, in any tool (Claude Code on a PC, cloud, claude.ai chat, the API) and any account (Om's, Akash's), works the
same disciplined way, and Work OS is always the true, current picture of all work. Then Om can see where everything
stands and steer from his phone without repeating himself. Agents use Work OS because it is the shortest path, not
because they are forced. Rules improve over time with one tap from Om. Judge every choice by this: Om and Akash use it
daily without friction.

## 1. What goes wrong today (survey of 8 sessions, Fable review)
- **Agents were told to drift.** Five agent-facing texts say "keep WORK-STATE.md": the org Orders (14 Oct), the
  server instructions ("keep WORK-STATE.md in the repo as its copy"), the save_state description ("write it to the repo
  and commit it"), the old global CLAUDE.md, and the orchestrator's transfer protocol note.
- **Four lists of work:** tasks, Claude items (C12), State Next/Later, and Needs. Plus WORK-STATE.md. An agent can't
  tell which one to use, so it uses the file.
- **The right way costs more than the wrong way.** State has no op to edit or remove a line. Lines are addressed by ids.
  Some ops need a version. Every save returns the whole State twice (about 1,500 tokens).
- **Rules live in chats and memory.** A correction reaches one session. Nothing checks anything.
- **Built and not switched on.** The 15 Nov hook was never installed. "Done" meant merged, not "running on the PCs".

## 2. Interfaces: where an agent meets Work OS

| Interface | What it is | Reaches | Role |
|---|---|---|---|
| MCP server (work.delpat.in/api/mcp) | Work OS tools | Every tool and account | The only way agents read and write work |
| Server instructions | Text every MCP client gets on connect | Every tool | Line one: "call start_work first". Short (about 2,500 characters); details live in tool descriptions |
| Tool descriptions and answers | Per tool | Every tool | Teach the routine at the moment it's used; answers say what to do next |
| start_work brief | Orders + State + tasks + who else + messages | Every tool | The session's starting context |
| forYou line | One line on any answer | Every tool | "2 messages, Need #41 answered, Orders changed": ids and counts |
| Hooks (worker setup) | Small programs Claude Code runs at start, on tool calls and at turn end | Claude Code on PCs and cloud | Delivers the brief and messages, keeps WORK-STATE.md, the three blocks, presence |
| The worker on a PC | The Work OS background program, with this PC's device key | Om's and Akash's PCs | Runs sessions it's asked to; gives the hooks their key (section 4) |
| The app (web and phone) | Screens for people | Om, Akash | Needs, State card, Workers/Sessions, Orders editing, review |
| Discord and push | Alerts | Om, Akash | Needs and digests reach the phone |

## 3. Documents: what each holds

| Document | Holds | Written by | Never holds |
|---|---|---|---|
| Global CLAUDE.md (per PC) | Bootstrap (start_work, follow the Orders) and facts about this PC | The PC's owner | How to work, status |
| Orders: org / project / person | How agents work. Rule ids, at most 40 lines for org, versioned | The holder in the app; the holder's own Claude with write_note (a version, with why); a teammate's Claude proposes with propose_order | Status, PC facts |
| State (Now, Next, Later, Decisions, Where) | Where the project stands | Agents (save_state / edit_state), people in the app | Rules, how-tos, history |
| Tasks | Deliverables a person tracks: owner, due date, review | People and agents | A copy of every Next line |
| Needs | One question for one person | Agents (ask) | Status |
| Notes, on shelves: Overview, Designs, Runbooks, Handovers, Archive | What people read | People and agents; duplicates refused | Status |
| Repo CLAUDE.md / AGENTS.md | The Work OS project name, the code's rules, what exists here (scripts, assets) | Agents, in git | Status, how to work |
| Repo docs (docs/, HANDOVER) | How the code works | Agents, in git | Plans, status |
| WORK-STATE.md | A copy of State, written by the hook | The hook only | Anything typed by an agent or a person |
| Memory | Facts about the person and the PC; a correction waiting to become an Order | Claude's memory | Standing rules, status |

**Claude items (C12) retire.** They duplicate State and tasks: discovered work → a State Later line, ordered work →
Next, a deliverable someone tracks → a task, "waiting on Om" → a Need. One migration per project, then
update_claude_items goes away (and its lines in the server instructions). Built in H11: migrated (steps 7 and 8, scripts/migrate-claude-items.mjs); the tool, get_project.claudeItems, the Queue tab and the badges are gone, and the old items stay read-only on the project's Claude tab.

## 4. Keys and connections
- **Why the hook needs its own key.** Claude Code's Work OS connection keeps its sign-in inside Claude Code's own
  config. Hooks are separate programs and don't get it (and we never touch that file). Until 18 Nov the hook read
  WORK_OS_KEY from the PC's Claude Code settings (still used first when it is set: a PC without the worker).
- **Change (builder A): no extra key.** The worker already runs on the PC with a device key. The hook signs in with
  that key on new hook-only routes (`/api/agent/start`, `/api/agent/event`, `/api/agent/wait`), which can do only what
  a hook needs: brief, State, presence, messages. They can't do mail or deletes. A PC with no worker (cloud) gets a
  project-scoped hook key in its environment. Built 18 Nov: `/api/agent/start` (the start brief and the session token
  of section 16 item 8; docs/HANDOVER.md "Claude Code hooks"). `/api/agent/event` is built (H6); `/api/agent/wait` is not.
- **Two Work OS connections in a session.** The PC's connection (Claude Code, user level) and the claude.ai connector
  (from the account) reach the same server. Both work (checked 18 Nov). Having both lists every tool twice and costs
  tokens on each turn. Rule: Claude Code uses the PC connection; the claude.ai connector stays off in Code sessions
  (done 18 Nov) and is used by claude.ai chat.

## 5. How a session works
1. **Start, and after every compaction** (hook): start_work for the folder. The brief puts the Orders, State,
   handovers for this project, messages and "Declutter due" into context. A folder no project owns: the session asks
   once which project it is and links the folder (sections 11 and 16.13 add: or creates the project, or marks the
   folder not Work OS; section 11 wins). claude.ai chat and the API have no hooks: line one of the server
   instructions tells them to call start_work.
2. **While working:** status goes to Work OS. State with edit_state / save_state, tasks with set_doing / log_progress /
   hand_in, questions with ask. Messages arrive after any tool call (hook) or in forYou.
3. **After every State save** (hook): WORK-STATE.md is written from the answer in the repo's main folder and committed
   on its own (not in builder worktrees, not during a merge). A hand edit of the file is refused today. Change: the hook
   forwards the edit to edit_state, so the old habit lands in Work OS (section 6).
4. **Turn end** (hook): files changed and State not saved → hold once and ask. Messages that came during the turn → the
   session continues to read them.
5. **Stopping or handing over:** wrap_up (State, leftovers, one friction line) or hand_over (for another session or
   tool). Built in H5: `end_work` (section 16.5 folds both into one call; see HANDOVER.md section 3).
6. **Idle** (hook): a direct message or question wakes the session (asyncRewake, tested 18 Nov).

## 6. Making State as easy as a file (builder B)
- **edit_state {project, old, new}:** the Edit tool's shape on State's markdown. Work OS applies the edit, re-reads the
  text into lines (keeps ids and history by matching), checks limits, and answers "Saved v8". A replace on a line
  changed since you read it is refused with that line's current text. No ids, no versions for normal edits.
- **save_state ops:** add `edit {id, text}` and `remove {id, reason}` (history keeps it); done for Later lines too.
  base_version only for set_now, and checked per line elsewhere.
- **Short answers:** "Saved v8. Next 6, Later 9." The hook fetches the markdown it writes; agents don't get the State
  twice.
- **Where fills itself:** the hook sends branch, head, uncommitted changes and worktrees with the brief and each save.
- **Next ↔ task:** a Next line with a task ref finishes when the task finishes, and the other way round.
- **Limits that don't cut:** long lines are kept whole up to the limit, then cut on a sentence; never split into a
  new line.
- **The hook forwards file edits:** an Edit, Write or shell write to WORK-STATE.md is sent to edit_state (the file
  diff) and refused with "Applied to Work OS State v8; the file is updated". When Work OS is down, the edit is queued
  outside the repo and sent when it's back.

## 7. Actions: routines served as Work OS tools
Tools reach every surface and an agent working alone; prompts and skills don't (Fable). Each answer says what is left.
- **Built in H5: end_work** (one call replaces wrap_up and hand_over, section 16.5) and **list_sessions** (the roster as a tool).
- **wrap_up** {project, state edits, changed, checked, left, friction}: saves State, lists leftovers (processes,
  uncommitted files, open slots, Needs), records the friction line. One call at the end of a stretch of work.
- **hand_over** {to: session, person, tool or "next"; step, tried, dropped, why, children}: capped fields, so it's a
  delta, never a pasted history. It writes the project's handover note. The next start_work in any tool or account shows
  it first and marks it read. This is Akash's "move chats between tools" (#165), option 1. Tools without MCP use the
  app's paste import.
- **declutter** {project}: Work OS lists what has grown: Later lines done, duplicated or untouched for 30 days; Next
  lines without a task or with a finished one; notes with matching titles or untouched for 14 days; done-but-open tasks;
  unanswered Needs. The session adds what it sees on disk (extra worktrees, branches, stray files). It proposes one batch
  as a single Need. On yes it applies it. **Triggered by growth** (Om): start_work and wrap_up say "Declutter due" when
  Later passes 25, Next passes 10, a line sits for 14 days, or notes duplicate. Also on demand from the app (project ⋯).
  *Built in H11:* `declutter {project, ask?}`; lines untouched 14 days (never one that waits on someone), notes duplicated by title or untouched 30 days; see docs/HANDOVER.md section 3 (Declutter).
- **propose_order** {project, layer (org or project), old?, new, why, incident?, repeat?}: for a teammate's Claude. A Need for
  the holder (Om for the org layer, the project owner for a project) with the old and new line and no phone alert;
  Accept applies it as one version. The holder's own Claude uses write_note instead. **Built in H9** (section 16.15).
- **feedback** {text, rule?}: "this got in my way", attached to the project with tool names and refusal codes. *Built in H10:* `feedback {project, text, tool?, rule?}`; refusal codes are the server's own `tool:kind` list; see docs/HANDOVER.md (feedback, H10).
- **who** {project?}: live sessions (name, machine, tool, state, task).
- Check in stays start_work.

## 8. Today's tools (50) and what changes

| Group | Tools | Change |
|---|---|---|
| Session | start_work, end_work, list_sessions, set_doing, slot, get_state, save_state, import_state | save_state: edit/remove ops, short answer, drop "write it to the repo". Add edit_state, wrap_up, hand_over, who. import_state: run by the hook when a repo with a hand-kept file first meets Work OS |
| Tasks | list_tasks, get_task, add_task, update_task, log_progress, complete_task, hand_in, add_comment, update_checklist, delete_task, restore_task, list_trash, apply_changes | Keep |
| Claude items | (update_claude_items, removed in H11) | Migrated (section 3) |
| Projects | list_projects, add_project, update_project, get_project, daily_summary, recent_activity | get_project's "start here from a repo" text → start_work |
| Notes | write_note, read_note, list_notes, delete_note | Shelves; duplicate titles refused; normalise quotes and dashes when matching edits *Built in H14* |
| Messages and Needs | send_message, message_status, reply, ask, needs, withdraw_need | Per-session ids; `to` is a session of yours (id or name) or a person; the frame on every message (the inbox tool went in Identity step 6) |
| Rules | (none) | Add propose_order, feedback; Orders version in forYou |
| Discord (4), Mail (12) | discord_*, mail_* | Keep; their detail leaves the server instructions for their own descriptions |

## 9. Wording: one set of words everywhere (builder S)
- **One glossary:** State (Now, Next, Later, Decisions, Where), task, Need, Orders, note, session, handover, copy.
  Retire "Claude item", "work state file", "transfer note", "boilerplate".
- **Rewrite every agent-facing text to it:**
  - server instructions (lib/mcp/docs.ts): line one is "call start_work first"; down from about 5,300 to about 2,500 characters;
  - every tool description and answer;
  - the hook's messages;
  - the WORK-STATE.md header;
  - the app's State card;
  - the Orders;
  - the global CLAUDE.md;
  - AGENTS.md and HANDOVER;
  - the orchestrator's transfer protocol note.
- **Built in H1:** the glossary is "Words" in docs/HANDOVER.md section 3; `tests/words-check.mjs` (`npm run check:words`, run by `prebuild`) is the drift test below.
- **A test keeps it from drifting back.** It fails the build if any agent-facing text says "write it to WORK-STATE",
  "keep WORK-STATE", "Claude items" or another retired phrase, or if the instructions grow past their budget.

## 10. Rules and enforcement
- **Orders are the one rulebook.** Org rules have ids and at most 40 lines (one in, one out). Each carries its date and
  incident. Orders have a version (the last 20 kept, undo in the app): a change shows in forYou and
  is delivered into an open session at its next turn (H7 delivery), so sessions don't keep the old rule. The holder's own
  Claude may change the text itself (H9; this replaces "set in the app only").
- **Three blocks only,** exact and irreversible (four of seven sessions asked for them):
  1. Push, tag or release to production without an answered Need.
  2. A production-linked CLI not aimed at the test target (vercel env, supabase secrets, `--prod`).
  3. Writing WORK-STATE.md (forwarded, section 6).
  Everything else is the Orders plus the turn-end save check. No word detectors.
  **Built (H8, 19 Nov):** blocks 1 and 2 are one grant. `ask` with `release: true` makes a release Need (approve, to the project's owner, fixed options, app only); Yes opens production on the project for 1 hour, Yes for 24 hours for 24. The pre-tool hook decides locally whether a Bash or PowerShell command is a production push, tag or release or a production CLI command (`worker/hook-release.mjs`, from the brief's `production`: remotes, branches, CLI targets; set in the app on the project page, never by an agent) and asks `POST /api/agent/release` (session token only) only then, sending what and a name. Refused with what to do; fails closed only on an exact match (no token, a slow or failing server). Block 3 is H4's hook (`hook-pre-tool.mjs`), proved by `worker/test/hook-h8.test.mjs`. See docs/HANDOVER.md section 3.
  **Changed 19 Nov (Om: "a release should not always be a tap in Work OS; it's enough that I say it in chat"):** in an attended session the hook lets a production push, tag, release or command through without a release Need. Attended: the person typed a prompt in this same main session within the last 30 minutes (`promptAt` in the marker, set by the UserPromptSubmit hook; a subagent's call, with `agent_id`, is never attended) and the run is not dispatched. The hook then adds a note: the agent must have the person's yes in chat and record their words as a Decision (`save_state` `add_decision`, quoting them) before or right after the push. The hook cannot check the chat, so the yes is the agent's duty, not a guard. Unattended (30 minutes without a prompt), dispatched, or a subagent's call: unchanged, a release Need yes is needed. A granted release Need still works everywhere.
- **Subagents** get a ten-line short form of the Orders at their start (hook), so rules don't depend on the brief.
- **Monday block in the digest:** four numbers (sessions that saved State, PCs with no hooks, refused edits, Om's
  repeats) and at most three proposals. Silence means keep.
  **Built (H12, 19 Nov):** `lib/monday.ts` `mondayBlock`, appended last to the organization owner's personal digest on a Monday (their timezone, their digest hour; the team channel digest is unchanged). The numbers are org-wide counts for the 7 days before today (presence `stopCheck` and `copyEdits`, devices seen that week with `worker.hooks`); proposals are open `batch: 'monday'` Needs of the last 14 days, oldest first, then friction groups from `feedback` and `session_ended` rows (a tool or rule in 3 or more lines, or from 2 or more sessions), at most three lines then "+N more in the app". Om's repeats says "not counted yet" (`REPEATS_COUNTED` false): H9 files a correction as a direct Orders edit with a why, and its `ordersLog` has no repeat mark to count. Nothing is written by silence.

## 11. Live sessions and messaging (from session-messaging.md, settled with Om)
- **The folder decides the project.** Code locations are `{path, host}`; the longest match wins; the git remote is
  information. Unknown folder: the session sorts itself out (asks once, links or creates). `claude -p`, workers and
  subagents stay quiet. **Built (H13, 19 Nov):** path locations take a `machine`; the device-key route takes the
  hook's `folders`; `start_work` gains `folder`, `link`, `not_work_os`; the remote only ranks suggestions; see
  HANDOVER.md section 3, "Claude Code hooks", "The folder decides the project".
- **Every session has its own id** (the session token's id, section 16.8, or one from start_work; not Claude Code's
  session_id). Seen state, presence and `to` (a message's addressee) key on it. This fixes the "same person, unread forever" bug.
  **Built (H3, 19 Nov):** `seenBy`, `toSids`, `sessionKey`, `isUnreadFor`; see docs/HANDOVER.md section 3, Messages.
- **Presence at zero tokens from hooks:**
  - On: SessionStart.
  - Working: UserPromptSubmit.
  - Idle: Stop.
  - Waiting: Notification.
  - Off: SessionEnd, or the worker's session list saying the process is not running.
  **Built (H6, 19 Nov):** `POST /api/agent/event` (wst_ token only), seven hook events, the five words on, working, waiting, idle, off, and `presenceState` as the one function (docs/HANDOVER.md section 3, "Session state"). The heartbeat is the worker's session list plus a pre-tool ping every 5 minutes while working (no plugin). Teammates see "waiting on a person", never why. Sessions without a token (WORK_OS_KEY, cloud, claude.ai) keep call-based state.
- **Delivery, any surface:**
  - After any tool call: PostToolBatch, a command hook (an http hook cannot send the per-session token, which lives in a file); posts at most every 20 s.
  - At turn end: Stop continue.
  - Idle wake: asyncRewake with a long timeout, re-armed.
  - Chat and API: forYou on the next call.
  - People: push and Discord.
  **Built (H7, 19 Nov):** delivery into sessions: prompt, tool batch, Stop continue and the idle wait (`POST /api/agent/wait`, `hook-wait.mjs`, asyncRewake), with the frame, wake caps (6 an hour per session) and the chain limit (2); see docs/HANDOVER.md section 3, Messages and Claude Code hooks. Hand check on Om's PC after release, results to record here: idle wake in the desktop app, VS Code and the terminal; a wait past one hour (the hook timeout is 3600 s; an 8 h timeout is not tried); a permission prompt open while a message comes (delivered after); a cloud session gets forYou only.
- **Built (Identity, 19 Nov; design in Work OS note 2afd68cb00, Om after a live test: "our ability to watch sessions is half"):**
  - **A message is to a session or a person, not to a project.** `send_message {to, project?}`: `to` is one of your own
    sessions (id or name; another person's session id is refused) or a person you share a project with; the project inbox,
    the `inbox` tool and the project Inbox tab are gone. A message to a person goes to their lead session on the project (no personal inbox, 21 Nov);
    `message_status` with no status reads the text.
  - **Every session is on the roster, with or without a project.** A folder no project owns gives a "No project" row,
    private to its person, with a token that opens only event and wait (hook protocol 3); messages to it, delivery and
    wake work as for any session.
  - **The roster says what is true:** the session name (rename, label, Claude's title), tool and model come from the
    hook; running comes from the worker's evidence (session files, `CLAUDE_PID`, command line); idle after 10 quiet
    minutes, off after 30 unless the worker says it runs (a running Bash or PowerShell call keeps it working: the hook's
    `tool-start`, while the worker says it runs or for 2 hours); `word` is `chat` only for the claude.ai connector with no session.
  - See docs/HANDOVER.md section 3 (Words, Messages, Claude Code hooks).
- **Message text is pushed with its frame** (who sent it, how it came in, what it may and may not ask). Shipping, money
  and credentials stay server-side as Needs.
- **Install:**
  - The worker setup installs the hooks on Om's and Akash's PCs (no plugin; a plugin only on a real need, Om 19 Nov).
  - One line per repo for cloud.
  - claude.ai chat uses the MCP only.
- **Hand check (18 Nov, desktop app):** all three delivery routes worked. Still to check: VS Code, the terminal,
  cloud, Notification, SessionEnd, and a wait longer than an hour.

## 12. Measuring (two weeks, counted by server or hook)
- Sessions that changed files and saved State before stopping: 3 of 8 today, target 9 of 10.
- PCs with no hook events.
- Refused or forwarded WORK-STATE.md edits.
- Om's repeated corrections.
  **Built (H12):** the first three are counted by the server from the session's own hook row (`stopCheck`, `copyEdits`, sent by `hook-stop.mjs` and `hook-pre-tool.mjs`) and the PC's reported hooks, and shown in the owner's Monday digest (section 10); the fourth reads "not counted yet" until something marks a repeat.
- The size of the Orders.
- The survey again on 2 Dec.
- On three random days Om opens five projects on his phone and asks "does this match?"

## 13. Who builds what
**First: finish what's 80% done.** Builder A: What's new and the Needs page. Builder B: recurring tasks. Both were
stopped on 18 Nov with work in their worktrees.

| Builder | Work, in order |
|---|---|
| A (Opus: access, security) | 1. Hook routes on the worker's device key (no extra key); hook-only and cloud keys. 2. Per-session ids (seen state, to_session). 3. The three blocks, in the hooks (no plugin). 4. propose_order and the Orders version. 5. Message frame and delivery (PostToolBatch, Stop, asyncRewake) |
| B (Opus: features) | 1. edit_state, edit/remove ops, short answers, auto Where, Next↔task, line limits. 2. Hook forwards WORK-STATE.md edits. 3. wrap_up, hand_over, declutter (with growth triggers), who, feedback. 4. Claude items migration |
| S (Sonnet: mechanical) | 1. Wording pass and the drift test (section 9). 2. Fold the three old designs into this one. 3. Hooks on a new PC from the worker setup, with the install command for Akash (a plugin only on a real need, Om 19 Nov) |
| Om | Paste the new Orders (rename to "Delpat Orders"). Say yes to the global CLAUDE.md swap. Answer the Declutter pilot Need for this repo's 169 old lines. Install on Akash's PC with him |

Each piece ships through dev, a full test run, then master. Security review before merge for A's work.

## 14. Open questions for Om
1. Retire Claude items (C12) into State, tasks and Needs? Recommended: yes.
2. Hook forwards WORK-STATE.md edits to Work OS (old habit works) instead of only refusing them? Recommended: yes.
3. The worker's device key for hooks (no copy-paste) instead of a Claude Code key? Recommended: yes.

## 15. Naming sessions (Om 18 Nov: "your name is outdated and it confuses me")
- **Pattern:** `<Project> · <role> · <what now>`. Project is the Work OS project name. Role is one of `lead` (the main
  session for a project, the one that talks to Om), `builder A|B|S`, `review`, `test`, `chat`. What now is two to six
  words, the State Now or a task ref. Examples: "Work OS · lead · agents and Work OS design", "Work OS · builder B ·
  recurring tasks", "Cutroom · lead · launch film", "Mailloom · review · mail frontend".
- **One name everywhere:** the session title in the app, the `label` given to start_work (so Workers, `who` and
  messages show the same name), and the name in builder briefs.
- **Kept current:** a session renames itself when its Now or task changes (in the desktop app, its rename tool; else
  the start_work label). wrap_up and start_work say "your name says X, your work is Y: rename" when they differ.

## 16. Changes after the Fable review (agent-system-review.md, 18 Nov; these override the sections above)
1. **Done already (a9412e3):** the turn-end check counts real save calls only (the brief's own text fooled it) and asks
   again after later changes, not once per session; no commit when only the version changed; the save_state and
   import_state answers and the server instructions no longer tell agents to write WORK-STATE.md (live after the next
   deploy).
2. **State editing (replaces section 6's edit on the whole markdown):** edit one line found by its text. `old` must sit
   in exactly one line of Now, Next or Later; Work OS replaces it inside that line; an empty `new` removes the line
   (Next: done, Later: dropped, kept in history). Every op takes `find` in place of `id`. An edited line becomes the
   editor's (no rewriting someone else's line under their name). Whole-file rewrites are dropped. The hook forwards the
   Edit tool only; Write and shell writes stay refused. No offline queue.
3. **Short answers wait for the hook:** the installed hook reads `markdown` from the answer, so the hook changes first,
   then the answer gets short.
4. **The copy is the same for every reader** (no "(by Akash)"), so two PCs never commit different versions. Public
   repos: leave Decisions out of the copy.
5. **end_work** replaces wrap_up and hand_over (one tool that pairs with start_work, with an optional handover part).
   "changed, checked, left" stay in hand_in only. `who` becomes `list_sessions`. Leftovers promise only what Work OS
   knows (slots, Needs, a task still doing).
6. **The brief fits in priority order** as plain text: handover, answers and messages, Now and Next, Orders, then counts
   ("Later 10: get_state"). The instructions budget (2,500 characters) counts both parts Claude Code keys get.
7. **Claude items retire in two steps:** remove the instructions paragraph now (S); migrate later (B) through a
   Declutter Need per project (an item with "done when" becomes a task, an idea a Later line).
8. **Keys:** at session start the hook swaps the device key for a session token (one session, one project, a day, its
   own rate limit), which is also the per-session id. The device key is only allowed for projects with a folder on that
   PC, and Setup's text says so. Until then a normal Claude Code key in settings.
9. **Declutter:** a line that waits on someone never counts as stale; after an answer, quiet for 14 days; the Work OS
   half of the batch applies on the server when Om says yes.
10. **Block 1** needs "production" per project (remote and branch): a new project field.
11. **Wording test** works the other way: every agent-facing string that names WORK-STATE.md must be on a short approved
    list; the app warns when Orders are saved with a retired phrase; the start hook reports a PC's CLAUDE.md drift as a
    number. "Claude items" joins the test when the migration lands.
12. **Phone:** only Needs a session is waiting on reach the phone; Declutter, rule proposals and the rest go in the Monday
    digest. A push Need offers "yes, and for 24 hours on this project". Wakes are capped per session per hour.
    **Built (H12):** `reachesPhone` (`lib/data/needs.ts`): a release Need and a Need a person asked always reach the phone; a review Need and a Monday Need (`batch: 'monday'`) never; any other agent or chat Need only while the session that asked is not off, checked when queued and again when sent (after quiet hours). "Yes for 24 hours" is H8's and the wake caps are H7's; not rebuilt.
13. **Akash's other folders:** the Lobby question gets a "not Work OS" answer, remembered per folder. **Built (H13):** per person on the server (`quietFolders:<userId>`), per computer and path, undone in Claude › Setup › Computers.
14. **Build order:** tonight (Om: Orders, CLAUDE.md, key). Then S alone first (wording pass, instructions paragraph, hook
    split into one file per event, packaging: the worker's update refreshes the hooks and reports their version). Then A
    (session token, per-session ids, the hook files) and B (line edit with `find`, remove, short answers in states.ts and
    the State tools) in parallel. Then A: blocks, propose_order, delivery; B: end_work, declutter, the migration.
    **H2 built (19 Nov):** hook.mjs split into a router and one file per event (`EVENTS` table), atomic install, `hooks check`
    and `hooks repo` (cloud), the worker reports its hooks (Computers shows hooks on / out of date / none), Link them for a
    computer's matching folders; see docs/HANDOVER.md "Claude Code hooks" and docs/setup-pc.md.

15. **Orders versions and edits (H9, 19 Nov; overrides the app-only rule in sections 5 and 10 and the Orders row in section 3).**
    The holder of a layer, and that person's own Claude (write_note, text and title only, `why` required), may change the
    Orders; Discord, a teammate's keys, archive, sub-pages, trash and restore stay refused or in the app. Every change is a
    version (last 20; person autosaves within 10 minutes fold); undo is the holder's, in the app. A teammate's Claude uses
    propose_order (a Need, no alert, Accept applies it as the holder). The brief, forYou and the turn delivery carry
    changes; a subagent gets the short form from the SubagentStart hook. **H9 built (19 Nov):** see docs/HANDOVER.md
    section 3, Orders.

## 17. The dispatcher (fleet plan of 14 Nov, task #259 and note 71d785b03c, folded in here)
- **What it is:** a session with role `dispatcher` that takes tasks marked "Give to Claude" and runs one worker per
  task (claim, readiness check, build, branch and PR, end). It works on **tasks**, not Claude items, so retiring
  Claude items does not touch it.
- **Two inputs:** tasks given to Claude in the app, and messages to the Discord bot (a mention or a DM), stored in Work
  OS and woken through the same wait call as idle sessions (section 11). The sender's permissions apply; production,
  money and credentials are approved in the app only.
- **Where it runs:** on a PC through the worker today (Claude › Setup step 3, "Claude starts tasks I give it", now off;
  task #266 checks it end to end), in the cloud later (#267, #268: cloud-ready repos, a project key per cloud
  environment).
- **How it fits this design:** it starts and ends every worker with start_work and end_work, names them
  `<Project> · worker · #ref`, and is supervised by Work OS through presence (section 11): no heartbeat means a fresh
  dispatcher, a dead worker's task is re-queued once, then goes to Om as a Need. **Built (H15, 19 Nov):** the server marks a dispatched
  session (this PC's own worker session row), its hooks refuse Orders edits and shell calls to the Work OS key and API, the claim cap is one
  transaction behind a per-person lock document, a session that ends on its own is put back once and then an app-only Need goes to the
  giver (Give to Claude again / Take back), and the prompt ends with end_work; see docs/dispatcher.md "As built (H15)". The cloud
  dispatcher (#267, #268) is its own part after H16.
- **Order:** after builder A's session tokens and per-session ids and builder B's end_work, because the dispatcher
  needs both. #259's subtasks 2 (Needs) and parts of 4 and 5 are built already; Declutter brings that task up to date.
