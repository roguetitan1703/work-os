# Work OS: what it is for (draft for Om and Claude to agree)

Status: **draft, 14 Nov 2026 (round 2).** Nothing here is agreed yet. Once a section or flow is agreed it gets marked
`Agreed` with the date, and from then on work on Work OS has to serve an agreed flow (section 11).

Detail behind this page (read-only reviews, 14 Nov): the feature inventory, the history report, the round 1 flow design
and the round 2 platform design, with real examples. They are kept outside the repo because they name clients.

---

## 1. Why Work OS exists

Om runs many client projects at once. Most of the work is done by agents: Claude sessions (chat, Claude Code on the
PC, cloud sessions), other AIs (Akash works in Antigravity), plus Akash and other teammates. The work is not short of
tools; it is short of **memory and attention**:

- **Context gets lost** between sessions, people, machines and days.
- **Om is the router for everything.** What needs him is buried in progress text, so it waits without him knowing.
- **Nothing notices drift.** Tasks sit at 90%, overdue dates never move, work waits on a laptop that is away.

### Om's view (14 Nov)

- **Any AI, any device.** Akash works in Antigravity and may move to ChatGPT or Claude tomorrow. Work OS must not care.
- **Not only code.** Claude Code is a general agent: cutroom writes, voices, renders and posts reels.
- **PCs are work machines, and nothing should block them.** Work goes on while Om is away. Dead Drop exists so
  credentials never block a session. If VS Code closes, a new session picks up.
- **Hand-over without files.** An idea from a chat becomes a note and a task on the project; the session reads it.
- **Sessions are orchestrators** that run builders, keep their state and Work OS true, and follow standing rules.
- **Everything is connected:** the PC, the sessions, Discord, where much of the team's context lives.
- **Keep the work state in the project**, so any session, AI or device can revive the work.

### What Work OS is moving against

Between 12 Oct and 12 Nov about 55,000 lines were written in 16 working days, each layer added before the one below was
in daily use. Many features are tested and never used once (section 4). The fix: agree what it is for, build in a
sequence where **each step is used for real before the next starts**, and only build what serves an agreed flow.

---

## 2. What Work OS is

**Work OS is the control room and the shared memory of a company whose workers are mostly agents.** People decide and
approve; agents do the work, on whatever machine is awake, in whatever AI the person prefers. Work OS is the one place
that knows, for every project: where the work stands, what is next, who or what is on it and where, what waits on a
person, and what came out. Any agent on any machine can walk in cold, ask for the brief and carry on. Any person can see
and steer all of it from the phone or from Discord. It does not hold the code, the conversation, the credentials or the
files; it holds the state of the work and the right to move it.

### The ten building blocks

| Block | What it is | Today |
|---|---|---|
| **Project** | The container: state, tasks, notes, repos, a Discord channel, a Delpat OS record | Yes (no state, no channel link) |
| **State** | The project's live memory: Now, Next, Later, Decisions, Waiting on, Where things are | No: it lives in WORK-STATE.md files on one laptop |
| **Task** | A piece of work with a done-when; repeatable work carries a recipe of steps and gates | Yes (no done-when, no recipe) |
| **Need** | One ask to one person (decide, approve, do, provide, review); parks the work until answered | No |
| **Result** | What a worker hands in: what changed, what was checked, where to look, what is left | No |
| **Worker** | A person, an orchestrator session, a builder under it, a standing job; with its AI, machine, task, last sign of life | Half: the PC worker reports sessions; history only says "claude" |
| **Machine** | A place work can run: Om's laptop, Akash's PC, the server, the cloud; with what it is ready for | Half: computers with linked folders |
| **Orders** | The standing rules agents follow (organisation, project, person), served to every AI | Half: one boilerplate note, read if remembered |
| **Door** | A way in or out: any MCP client, the app, Discord, mail, Delpat OS, phone push | Yes, of varying health |
| **Message** | Something said to a project, a worker or a person, kept until it is picked up, whoever is online | No: Claude Code sessions can only reach each other inside one account on one machine |

Every feature is one of these or a view of one.

---

## 3. What the data says (14 Nov)

| What | Count |
|---|---|
| Open tasks | 118 (31 P1); 30 In Progress, 17 of them at 85% or more |
| Shown as blocked or waiting in the brief | 26, but only **3** have the status Blocked |
| Open tasks whose last progress line says they wait on Om (three projects checked) | **18**, invisible to any list |
| WORK-STATE.md files across the Delpat folders | 71, counting builders' worktree copies; cutroom's main copy and its builders' copies differ by hundreds of lines |
| Projects marked active | 34; 19 with no open task |
| Changes made from Discord | 0, while 15 channels were active |
| Tasks ever given to Claude through the dispatcher on the live site | 0 |

- **Work that needs Om is invisible.** The tasks aren't blocked; they're finished up to the point where Om is needed.
- **Work waits on a machine, not only on Om.** A cutroom reel slipped a day because the laptop, the only machine that
  renders and posts, was away. A cloud session had done script, voice, storyboard and film code; "nothing is rendered
  yet: that waits on the laptop". Work OS had no way to say "needs a machine that can render".
- **State is the real product, and it is scattered** in repo files that the phone, other AIs and cloud sessions can't
  see, and that builders' worktrees fork.
- **Sessions already orchestrate, and build their own plumbing:** "Builder A fixing", a 30-minute cron asking "is there
  Next work?", PushNotifications naming what Om must decide. A roster, a keep-alive and a Need, hand-made per repo.
- **Hand-over still goes by paste** ("Paste into a fresh Claude Code session").
- **It is already not about code:** reels, client messages, invoices, numbers against predictions.
- **Only Claude is really connected.** Other AIs are "not tested"; every non-chat client is labelled "Claude Code".

---

## 4. What exists today, by real status

**Used:** tasks and projects through Claude (MCP); tasks in the app (Akash); subtasks, recurring; notes; team (sign-in,
invites, sharing, roles); morning brief and project picture; Dead Drop for env files in attended sessions.

**Live, never tried by a person:** several assignees, chosen-people sharing, live refresh; calendar link; AI tools
setup for other AIs; alerts on the live site (push, Discord DM, email); reel publisher timers.

**Built, never used:** the session launcher (start, resume, VS Code, reopen all, turbo clone, Claude Desktop); the
dispatcher (Give to Claude); Claude items; Discord commands and buttons; Delpat OS import; backups; mail tools (on a
branch, Mailloom not on the real mail server).

**Designed only:** the agent fleet (#259), chat backup (#168), two-way calendar, Dead Drop for unattended sessions (#269).

**Must fix whatever we decide:** backups (waits on Om); the worker editing `~/.claude.json`; dead code. Done 14 Nov:
deleted notes recoverable from Review › Trash; HANDOVER.md current.

---

## 5. The core loop

```
     doors in: any AI (chat, Claude Code, Antigravity, ...), the app, Discord, mail, Delpat OS
                                      |
                                      v
   1 CAPTURE  ->  2 READY  ->  3 WORK  ->  4 NEEDS A PERSON  ->  5 REVIEW  ->  6 SHIP / DONE
   task or a      who or       a worker     one Need, to one      the Result    ship is its
   Next line      what does    on a ready   person; work parks    is shown;     own step;
   in a project   it, where    machine      until answered        accepted or   weekly tidy
                                   ^              |               sent back
                                   +--- answer ---+
                                      |
     doors out: phone push, Discord (buttons, threads), mail, the brief
```

- A task is always in exactly one place: waiting to start, being worked on, waiting on a named person, or finished.
  "90%" stops being a place.
- Work OS holds the state of the work, not the conversation: sessions talk to Om in the Claude app (Remote Control),
  short steers can come through Discord.

---

## 6. The building blocks, designed

### 6.1 State lives in Work OS
Each project has one **State**: **Now** (one goal, who holds it), **Next** (ordered; task refs or lines; each says
whether it waits on a person), **Later** (one line each, with what it waits on), **Decisions** (dated, who decided;
only added, never rewritten, so a misread decision can't silently replace a real one), **Waiting on** (the open Needs,
not typed by anyone), **Where things are** (per machine, written by a script: branch, last commits, uncommitted files,
running servers). Stored as a versioned page; shown first on the project screen and on the phone.

- **Work OS is the master; the repo keeps a written copy** in WORK-STATE.md, marked with the version it came from.
  Code, long documents and build instructions stay in the repo.
- **On start, one call from any AI:** `start_work(project or git remote)` returns the brief: the Orders that apply,
  the State, answered Needs, tasks handed to this worker, open tasks, messages, and who else is working on it now.
- **While working:** small State writes carrying the version they read; a clash returns the newer State instead of
  overwriting it.
- **On stop or merge:** update Work OS, then write the repo copy and commit it with the work.
- **Only the orchestrator writes State**; builders report on their tasks. That ends the forked copies.
- A repo with no State yet imports its WORK-STATE.md once. If both sides changed the same section, Om is asked.
- Claude Code hooks (start and stop) can make `start_work` and the save automatic, so it doesn't depend on a session
  remembering.

### 6.2 Workers and machines
- **The roster** (one screen, Workers): name and role, acts for whom, AI and model, machine, project/repo/branch,
  doing what, builders under it, state (working, waiting on a person, idle with Next work, gone), last sign of life.
- **How Work OS knows:** `start_work` registers the worker and every later call is a sign of life (any AI); the PC
  daemon's reports add "alive but silent"; orchestrators report their builder slots; each connected tool has its own
  sign-in, so history says "Antigravity for Akash".
- **Every Work OS answer ends with a short "for you" line** ("1 new task: #270; your Need was answered"). That is how
  an agent in any AI learns of new work without extra machinery.
- **Machine limits across sessions:** a session asks for a heavy slot on its machine; the cap holds across all sessions.
- **"Idle with Next work"** (unblocked Next items, nobody alive on the project) is the most valuable line on Om's phone.
- **A machine is ready for a project** when: the repo is there or can be cloned; the env can be pulled with nobody
  present (Dead Drop unattended, never production); the tools it needs are present; an AI is signed in; it may run
  unattended (permission rules, heavy-job cap). Projects can name one-machine steps ("posting needs the token held on
  the laptop") so the fix shows as a to-do, not a surprise.
- **The launcher is the machine layer, not clutter.** Start, open in VS Code, turbo clone stay. "Reopen all" changes
  meaning: it starts fresh sessions with the brief, never tries to revive old conversations. Open in Claude Desktop and
  the `~/.claude.json` edit go.
- **Routing work:** a live worker on the project gets it on its next call; else the daemon starts a fresh session on a
  ready machine; else the cloud dispatcher (6.5) if the project is cloud-ready; else the task says plainly what it waits for
  ("needs a machine that can render; the laptop was last seen 9 h ago"). Work is **pushed** where something can start a
  session (Claude Code via the daemon, cloud) and **pulled** everywhere else ("what's mine?" in Antigravity).
- **Orchestrators** get the Orders served, post one report per merge or stop in Om's format (changed, tested, next,
  works / awkward / doesn't work), and are kept alive from outside: one nudge if quiet while Next has unblocked work, a
  fresh session if gone. Hand-made keep-alive crons stop being needed.

### 6.3 Needs and results
- **Need:** one ask to one person: kind, the ask in plain words, a real example, options, a recommendation. The task
  shows "Needs Om" instead of a percent; one push; answered from the phone, Discord or a chat. Waiting on a client is
  addressed to whoever chases it. Replaces "waits on Om" in progress text, WORK-STATE and PushNotifications.
- **Answers reach the work:** the session sees it on its next call ("for you"); on a machine with the daemon it is
  woken with a fixed line that names the Need and never contains the answer text; if the session is gone, the next
  worker reads it first in the brief.
- **Result:** what changed, how it was checked and rated, where to look, what is left. Code: a PR or preview. Reel: the
  preview page. Client message: the draft in the note. Invoice: a link to Delpat OS. A check: three lines, finishes by
  itself. **Work OS links, it doesn't store files.**
- **Review before Done** for anything that changed code or data or goes to a client: Accept, Send back with a line, or
  Accept and file what is left.

### 6.4 Recipes and ship steps (work that isn't code)
- A task can carry a **recipe**: named steps, some of them **gates** (a Need declared in advance). Recipes belong to
  the project and are reused. Cutroom's reel: script → gate → voice → storyboard → gate → film code → drafts → blind
  checks → final render → gate → ship at the slot → numbers on day 1 and 7.
- Steps can say what they need ("render: a machine with the render stack"), so Work OS knows a step can't run in the cloud.
- **Ship is always its own step.** A project's Orders say which ship steps an agent may take alone (posting a reel Om
  approved at the last gate: yes) and which need a go.
- **Repeating work is a recipe on a schedule:** a reel every other day, a monthly client update before the invoice,
  post-release checks. Each run is a task assigned to "any agent that can".

### 6.5 The cloud dispatcher, and Discord through it (agreed with Om, 14 Nov)
**One long-running cloud Claude Code session, the dispatcher** (fleet plan #259, task #267). It runs one subagent per
task, at most 2 or 3 at once, and is restarted daily. It has two inputs:
1. **Tasks handed to Claude** (its existing job).
2. **Messages to the Discord bot**: a mention in any channel, or a DM.

It also checks in every 30 minutes by itself.

How a Discord message travels:
```
Discord ──► bot (Work OS server) ──► Work OS stores it ──► wakes the dispatcher (cloud)
                                                             │ reads it, decides, acts
                 reply in Discord ◄── Work OS ◄──────────────┤
                                                             ├─► work: a task, run by a subagent (branch + PR)
                                                             ├─► news for a project: that project's inbox (6.6)
                                                             ├─► a question: answered from Work OS
                                                             ├─► needs the PC (render, browser): handed to the PC
                                                             └─► needs Om: a Need
```
1. **Om writes in Discord**, e.g. "@WorkOS tell cutroom captions are burned in, and hand #249 to Claude".
2. **The bot hears it.** *New:* today the bot only gets slash commands and buttons. Plain mentions and DMs need a small
   always-open Discord connection in the Work OS server (measure memory first; fallback: check for new mentions every
   10 seconds).
3. **Work OS stores it** as an inbox item for the dispatcher, with:
   - the sender, from their linked Discord account; an unlinked person gets "link your account";
   - the channel, and a link back to the message;
   - the text, labelled as written by that person.
4. **Work OS wakes the dispatcher.** The dispatcher keeps one background "anything for me?" call open to Work OS, so
   the item's arrival wakes it. The call returns the item id only, never its text, and uses no tokens while waiting.
   Each call also counts as its heartbeat.
5. **The dispatcher reads the message and acts as the sender.** It reads through the Work OS tools, with permission
   scoped to the sender: Akash's message sees only what Akash can see. In the example:
   - it puts "captions are burned in" in cutroom's inbox, and the next cutroom session picks it up;
   - it takes #249 and runs a subagent on it.
6. **The reply goes back to Discord** through a reply tool; Work OS posts it with the bot ("Sent to cutroom: offline,
   it'll pick it up. #249 started."). *New:* today the bot can't post. History records "dispatcher for Om, via
   Discord".
7. **Work OS keeps it alive.** No heartbeat for a few minutes, or a full context, means a fresh dispatcher. Nothing is
   lost: the messages and claims live in Work OS, and claims of a dead dispatcher are re-queued once, then go to Om.

**The rules:**
- Om's messages are instructions.
- A teammate's message is an instruction only for their own work.
- An unlinked person's message is information.
- Production, money and credentials are approved in the app, never from Discord.
- A button counts only when the person it is addressed to presses it.
- Private projects reply only in the owner's DM.

**Also through the bot, without AI:** Needs arrive as messages with buttons, and results post to the sender's DM or
the project's channel.

**Still open:**
- how long a cloud session may live;
- whether a cloud session can reach work.delpat.in with a key (it can't reach os.delpat.in, #269);
- how much memory the Discord connection costs on the server.

### 6.6 Messages: Work OS as the messaging service between agents and people
Om's need (14 Nov): he is talking to Claude chat about cutroom, no cutroom session is running; the chat drops a
message, and when a session comes online it picks it up. Today Claude Code sessions can only message each other inside
one account on one machine; nothing reaches a session that is offline, in the cloud, on Akash's PC or in another AI.
Design draft: the Work OS note "Cross-session messaging: design draft for discussion" (#265).

- **Address the project, not the session.** Sessions come and go; each project has a durable inbox. A message can also
  name a worker (a builder slot) or a person.
- **Anyone can send:** any AI session (chat, Claude Code, cloud, Antigravity), the app, a Discord thread, Om from his
  phone. Kinds: decision, request, question, fyi. Refs to tasks, commits, files. Threads and replies.
- **Delivery, whoever is online:** a session starting on the project gets unread messages in its brief (`start_work`
  and the start hook, also after compaction); a running session gets them through the "for you" line on its next Work
  OS call and a cheap hook check every few minutes; on a machine with the daemon, an idle session is woken with a fixed
  line naming the message (never its text). Nobody online: it waits, and the sender sees "cutroom: offline, last active
  3 h ago".
- **Status:** unread → seen → applied (with the commit) or rejected (with a line). The sender sees it land.
- **Decisions go to the project's State** (Decisions section, dated, who decided), and so into the repo copy. One
  central log, no separate DECISIONS.md to keep in step.
- **A request can become a task** with one tap or one call.
- **Trust:** a message Om wrote himself (typed in the app, Discord, or said in a session he is in) counts as Om's word.
  A message one agent sends on its own is a proposal: shown to Om if he is present; with nobody present it becomes a
  Need, and the agent sticks to its task as written. A teammate's message is information for Om's agents and an
  instruction only for the teammate's own agents.
- **Stale:** a message carries the sender's date and commit; unread after 7 days it shows in the weekly tidy.
- **Discord is a client of this service, not a separate system:** a message to the bot reaches the cloud dispatcher
  (6.5), which drops news into the right project's inbox. Discord, chat, the app and every AI write to the same inboxes.

### 6.7 Who owns what

| Thing | Owner | The other side |
|---|---|---|
| Clients, the commercial project record, invoices, meetings | **Delpat OS** | Work OS links by id; no sync |
| Credentials and env files | **Delpat OS (Dead Drop)** | Work OS holds none, ever |
| State, tasks, Needs, results, notes about the work, workers, machines | **Work OS** | |
| Sessions and their conversations | **The AI** (Claude app, Remote Control, ...) | Work OS keeps the worker record |
| Code, long documents, a written copy of the State | **The repo** | |
| Team talk | **Discord** | Work OS reads, posts Needs and reports, links back |
| Mail | **The mail server, through Mailloom** | Work OS reads and sends with each person's key, stores no mail |

---

## 7. The flows (to agree one by one)

Status words: **used**, **built-unused**, **new**. "Works when" lines become each flow's end-to-end test.

### Starting and handing over
- **S1 Start work anywhere.** *New call, built from `get_project` and the boilerplate note.* Any agent, any AI, any
  machine: `start_work` → registered as a worker → the brief → two lines on what it found and will do.
  *Works when:* two different clients on one project get the same State version and Orders, appear as two workers with
  their own AI names; an unknown remote returns candidates.
- **S2 Save state.** *New.* On stop, merge, a decision, or a nearly full context: write State with the version read,
  merge on a clash, then the repo copy, committed with the work. *Works when:* a stale write changes nothing and
  returns the current State; the repo copy's version equals Work OS's after a stop.
- **S3 Continue from the phone.** *New on the built start job.* The project screen says "Next has 2 items that can
  run; nobody is on it"; Continue → pick a ready machine or the cloud → a fresh session does S1. *Works when:* one start
  job whose prompt is the fixed line with the project id and no State text; with no ready machine, it says what's missing.
- **H1 From an idea in chat to a project, no file.** *Partly used.* The chat writes a note, the tasks and a Next line;
  a live worker on that project gets the "for you" line; else S3 or W2. *Works when:* a checked-in worker's next answer
  carries the "for you" line once; a new worker's `start_work` lists the item first.
- **P1 Another AI picks up its work.** *Snippets built, untested.* Akash in Antigravity: "what's mine?" → `start_work`
  → same brief, same Orders → history says "Antigravity for Akash". *Works when:* Akash has done it once for real.

### Messages
- **MS1 Drop a message for an offline project.** *New.* Om in Claude chat: "tell cutroom captions are burned in" →
  `send(cutroom, decision, ...)` → the chat says "cutroom is offline, last active 3 h ago; it will get this on start".
  *Works when:* with no live worker, the message is stored unread; the next `start_work` on cutroom lists it first.
- **MS2 A running session picks it up.** *New.* *Works when:* a checked-in worker's next Work OS answer carries the
  "for you" line once; on a stub daemon an idle session gets one wake job whose prompt names the message id only.
- **MS3 Apply, reply, or reject.** *New.* The receiving session applies Om's message (or asks him, if an agent sent
  it), records the commit, adds a decision to State, replies. *Works when:* the sender sees "applied" with the commit;
  an agent-sent message to an unattended worker becomes one Need and changes nothing.
- **MS4 Across people and tools.** *New.* Akash's agent in Antigravity sends a request to a shared project; Om's
  session sees it labelled as Akash's. *Works when:* it arrives as information and creates no instruction for Om's
  agent.

### Capture and knowing what is on
- **A1 Om tells an AI, it files it.** *Used.* Tasks with project, who, a done-when, a date if given; long content in a
  note; marks what an agent could do itself.
- **A2 A teammate adds a task in the app.** *Used.* One alert to the assignee; recurring makes the next one.
- **A3 From a Discord message.** *Built-unused.* "Add to Work OS" or `/task`; linked back; text labelled with its author.
- **A4 From a mail.** *On a branch.* A mail becomes a task, labelled as outside mail, no duplicates.
- **B1 Om's morning.** *Used in part.* Needs first, then results to review, due and overdue, gone quiet, idle with Next
  work, Discord and mail that need him. Om answers Needs right there.
- **B2 A teammate's day.** *Used, minus Needs.* Needs first, then assigned and due.
- **B3 Phone alerts.** *Built-unused live; prove first.* Push for: needs you, a result or a stop, assigned to you, due
  today (one digest). Tap opens the exact Need or task.

### Needs, results, recipes
- **N1 Ask one person one clear thing.** *New.* *Works when:* the Need shows under "Needs you" in the brief and Today,
  one alert, a second of the same kind replaces the first.
- **N2 Answer and the work continues.** *New.* Next call, woken by the daemon with a fixed line, or read first by the
  next worker.
- **R1 Hand in a result, review.** *New.* *Works when:* `complete_task` by an agent on code work gives a review Need,
  not Done; Send back re-queues with the line first in the brief.
- **K1 A recipe with gates.** *New.* *Works when:* finishing the step before a gate opens exactly one Need; no later
  step can be ticked until it's answered; "change" reopens the step with the answer.
- **K2 Ship.** *Reel timer built-unused; mail on a branch.* Ship alone where the Orders allow, else an approve Need;
  production, money and new credentials only in the app. *Works when:* an approved reel books its slot and records the
  post; a deploy's approve Need can't be satisfied from Discord.

### Workers and machines
- **W1 The roster stays true.** *Daemon half built.* *Works when:* a worker that stops calling and whose process is gone
  shows as gone within one cycle and its task as unheld; builders show under their orchestrator.
- **W2 Assign to any worker.** *Claim, cap and start job built-unused; routing new.* Live worker, else ready machine,
  else cloud, else "waits for a machine that can …". Who may hand over without the app: Decision 7.
- **W3 An orchestrator delegates and reports.** *Done by hand today.* Heavy slot, builders each on one task, review
  agent where Om's rules demand, one report. *Works when:* a third heavy-slot request on a cap of 2 waits; the report
  appears once on the project and once in the channel.
- **M1 Make a machine ready.** *Clone and folder link built.* The five ticks, a dry run that does S1 and stops.
- **M2 The lid opens and work resumes.** *Replaces Reopen all.* For each project with unblocked Next work last worked
  from this machine and no live worker: a fresh session, up to the cap; one push "laptop is back: X and Y continuing".

### Discord
- **DC1 Answer a Need, hand over, see the state.** *Commands built and switched off; posting new.* *Works when:* the
  addressed person's button press answers once, anyone else's is refused, a private project's Need never hits a channel.
- **DC2 Message the bot, the cloud dispatcher handles it.** *New (dispatcher designed in #267).* Mention or DM →
  stored with the sender → dispatcher woken → task and subagent, project inbox, answer, PC hand-off or a Need → reply in
  Discord. *Works when:* a stub mention from the linked owner wakes the dispatcher once (its wait returns the id, no
  text) and gets one reply; the same text from another member instructs nothing beyond their own work; a member who
  can't see a private project gets nothing from it; with the dispatcher dead, the item waits and a fresh dispatcher
  takes it.

### Keeping it honest
- **F1 The weekly tidy.** Projects with no open task, duplicates, overdue, tasks quiet for 14 days; Om says yes or no
  per group; one `apply_changes` with a dry run.
- **F2 Quiet work is flagged.** In Progress with no change for 2 working days, overdue with no date change, a Need
  unanswered for 2 days, a worker with no sign of life. A task waiting on a Need is never "quiet".
- **E1 Team.** Live; keep. Needs work for every member.

### Side uses
**Keep:** calendar link, reel publisher, Work OS's own SMTP. **Freeze:** chat backup, two-way calendar. **Cut:**
schedule / day plan / page tint / timetable, Claude items as a list (folded into tasks and Needs), the `claude-code`
tag, paste import, Open in Claude Desktop, dead code.

---

## 8. The six-month sequence

Each step is usable by itself, stands on the one before, and **is used for real before the next starts**.

| # | Capability | What Om can do the day it lands |
|---|---|---|
| 1 | **State, the brief and the inbox** (`start_work`, State in Work OS, Orders served, the "for you" line, project messages) | Close the laptop mid-work, open a fresh session anywhere, lose nothing. Drop an idea or a message from chat into a project; the next session picks it up. Read every project's Now and Next on the phone. |
| 2 | **Needs and results, with push and Discord buttons** | One list of what waits on him; answer from phone or Discord; accept or send back. |
| 3 | **The roster: workers and machines** | Who is working, on what, where; what could be running but isn't; caps that hold. |
| 4 | **Assign to anyone, Continue, lid-open resume** | Hand a task to "any agent that can" from the phone; work restarts when a machine returns. |
| 5 | **Recipes and ship steps** | A reel as a recipe with three approvals from the phone, posted at the slot; monthly updates drafted on schedule. |
| 6 | **A second ready machine, the cloud made ready** | No work waits on one laptop. |
| 7 | **The cloud dispatcher, listening on Discord** | Message the bot; the dispatcher answers, starts the work, or passes news to the right project. |
| 8 | **Any AI, proven** | Akash works in Antigravity or ChatGPT with the same State and rules. |
| 9 | **Mail as a door** | Client mail drafted, approved, sent. |
| 10 | **The scorecard** | Weekly: runs started, accepted first time, sent back, how long Needs waited, which machine was the bottleneck. |

**First three to build:** State, the brief and the inbox (start with cutroom and Work OS itself; messages ride on
the same start call, hook and "for you" line, so they cost little once those exist); Needs and results with push and
Discord buttons (prove alerts live, set the Discord address, turn today's hidden waits into Needs); the roster.

---

## 9. The guards that stay (each stops something real)

- Only the person an agent acts for instructs it; everyone else's text (teammates, Discord, mail) arrives labelled.
- The line that starts or wakes a session never contains task, State or answer text, only ids.
- Production, money and new credentials are approved in the app, never from Discord or by an agent alone.
- Credentials go server → script → disk, never through a model, never production unattended (Dead Drop's rule).
- The machine daemon does a short fixed list of things and has an off switch per machine.
- Unattended agents draft outside mail; a person sends.

Nothing else: no "app only" hand-over, no freezing the machine layer, no waiting periods.

---

## 10. Decisions for Om

| # | Question | Recommendation |
|---|---|---|
| 1 | Where does project state live? | **Work OS is the master, the repo keeps a written copy.** One line of the global rules changes. |
| 2 | Orders served by Work OS to every AI? | **Yes**, organisation, project and person layers; CLAUDE.md stays Claude Code's local copy. |
| 3 | One Need for every kind of waiting? | **Yes**, one list, kinds differ only in buttons. |
| 4 | May agents mark their own work Done? | **Only read-only checks and reports**; code, data or client-facing work gets a review. |
| 5 | Discord | **Agreed 14 Nov: the long-running cloud dispatcher listens on the bot** (6.5). Discord may steer, not release. |
| 6 | A second ready machine | Akash's PC, a spare, or a bigger server; the current server is too small for sessions. |
| 7 | Who may hand over outside the app? | **Any agent, for tasks whose text is all Om's or his own agents'**; others' text turns it into a one-tap approve Need. |
| 8 | Permission mode for unattended sessions | **Edits allowed plus a per-repo allow list** (test, build, git); anything else asks via Remote Control and becomes a "stuck" push after 20 min. |
| 9 | Delpat OS owns the client record? | **Yes; link by id, no sync.** |
| 10 | Unattended outside mail | **Draft and approve Need**; in a session with Om present it sends. |
| 11 | Reel posting off the laptop | **Put the posting token in Dead Drop** so the server timer or another machine can post. |
| 12 | The worker editing `~/.claude.json` | **Stop.** Trust each folder once by hand; the worker reports "needs trust". |

---

## 11. How we work from here

1. **Agree** sections 2, 6, 7 and 10: cut, merge, add. Each agreed flow keeps its id.
2. **Write each agreed flow** in `docs/flows/<id>.md`: the person, the steps, the "works when" checks.
3. **One test per flow** in `tests/flows/`, end to end (browser and MCP). A flow is done when its test passes **and** a
   real person has used it once on work.delpat.in.
4. **Stability rule:** a change to Work OS names the flow it serves (or a bug in one); anything else goes to Later. No
   new flow without agreeing it here first. Each step of section 8 is used for real before the next starts.
5. The must-fix list in section 4 comes first; it is safety, not a feature.
