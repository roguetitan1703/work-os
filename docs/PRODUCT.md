# Work OS: what it is for (draft for Om and Claude to agree)

Status: **draft, 14 Nov 2026.** Nothing here is agreed yet. Once a section or flow is agreed it gets marked `Agreed` with
the date, and from then on work on Work OS has to serve an agreed flow (section 8).

Detail behind this page (read-only reviews, 14 Nov): the feature inventory, the history/status report and the flow
design with real examples, kept outside the repo because they name clients and people.

---

## 1. Why Work OS exists

Om runs many client projects at once. Most of the work is done by Claude sessions (claude.ai chat, Claude Code on the
PC, cloud sessions), plus Akash and other teammates. The work is not short of tools; it is short of **memory and
attention**:

- **Context gets lost** between sessions, between people and between days. A new session starts blank; a teammate
  doesn't know what Claude did; Om has to remember and repeat.
- **Om is the router for everything.** Decisions that need him are buried in progress text ("waits on Om"), so they
  wait without him knowing.
- **Nothing notices drift.** Tasks sit at 90% for days, overdue dates never move, a session misreads Om and logs the
  wrong decision, and nobody sees it until Om does.

**Work OS is the one shared place where the work lives:** what is being done, by whom (person or Claude session), what
state it is in, and what needs Om. Every Claude session and every teammate reads from it and writes back to it.

### What Work OS is moving against (the risk to Work OS itself)

Between 12 Oct and 12 Nov about 55,000 lines were written in 16 working days. Each layer was added before the one
below was in daily use: tracker, then Claude's logbook, then a session launcher, then a dispatcher, then a team app,
then a reel publisher, then the agent-fleet plan. Settings was reshaped four times, navigation three times, Today four
times, sign-in built twice. Many features are merged, tested and security-reviewed but **never used once** (section 3).

So Work OS is drifting into the same problem it is meant to solve: daily change, unclear state, things waiting on Om
without him knowing. The fix is the same too: agree what it is for, write it down, and only build what serves that.

---

## 2. Who uses it, and how they really use it today

| Who | How they use Work OS today (activity since 1 Oct) |
|---|---|
| **Om** (owner) | Almost only through Claude: plans and files work in claude.ai chat; Claude Code sessions log his client work. 16 changes made in the app himself between 25 Oct and 14 Nov, on 4 days. Reads on the phone. |
| **Akash** (teammate) | The most hands-on app user: creates tasks, assigns himself, recurring tasks, blocks, reopens with a comment. Also uses Claude chat for his projects. |
| **Claude Code sessions** (Om's PC) | The biggest writer (~205 changes since 1 Oct): progress lines, checklists, completions, drafts for Om, mostly on client work. 25 of the 27 notes. |
| **claude.ai chat / cloud Claude Code** | Planning and filing tasks for Om and Akash. Recorded as "claude", not told apart from each other. |
| **Server** | Alerts every 15 min; reel publisher (installed 12 Nov, not used yet). |
| Discord | No change made from Discord, while 15 channels were active since 15 Oct (commands never pointed at the new server). |

**In practice Work OS is two things today: Claude's logbook for Om's client work, and Akash's task list.**

---

## 3. What exists today, by real status

**Used for real**
- Tasks and projects through Claude (MCP: add, update, log progress, complete, notes, apply_changes).
- Tasks in the app for Akash: create, assign, status, recurring, block, archive, comments.
- Subtasks. Recurring tasks. Notes (written by Claude sessions as handovers and client context).
- Team: sign-in, invites, shared/private projects, roles.
- Morning brief (`daily_summary`), project picture (`get_project`).
- Delpat OS Dead Drop for env files in attended Claude sessions.

**Live but never tried by a person**
- Several assignees, sharing with chosen people, live refresh.
- Calendar link (ICS), Settings › AI tools (only Claude Code tested).
- Alerts on the live site: push, Discord DM, email (only tested against fakes).
- Reel publisher (installed and self-tested by cutroom; no real reel yet).

**Built, never used**
- **Starting Claude from Work OS, 7 ways.** Only Start was tried once (15 Oct).
- **Dispatcher (Give to Claude):** one run on a demo copy (17 Oct), never on production.
- Claude items (C-numbers): 7, only in the Work OS project, untouched since 16 Oct. The `claude-code` tag: 11 tasks, one plan.
- Discord slash commands, Delpat OS import, backups to R2, schedule/day plan.
- Mail tools for Work OS (on a branch, against Mailloom, which is not on the real mail server yet).

**Designed, not built**
- Agent fleet (#259): needs-Om queue, staleness flags, session identity, plugin hooks, messaging, cloud dispatcher.
- Chat backup (#168), two-way Google Calendar, Dead Drop for unattended cloud sessions (#269).

**Must fix whatever we decide (risks found in the review)**
1. **No backups in production.** The only copy of the data is Atlas. (Waits on Om: bucket, token, key.)
2. ~~Deleted notes can't be recovered.~~ Done 14 Nov: Review › Trash restores or purges notes.
3. **The worker edits `~/.claude.json`** on every folder link: the same file that was wiped once. (Decision D9.)
4. ~~HANDOVER.md describes Vercel and old screens.~~ Done 14 Nov.
5. Dead code and unused dependencies (status panel, theme toggle, timetable API, nginx, react-markdown, ...).

---

## 4. What the data says (14 Nov)

| What | Count |
|---|---|
| Open tasks | 118 (31 are P1) |
| In Progress | 30; 17 of them at 85% or more |
| Shown as blocked or waiting in the brief | 26, but only **3** have the status Blocked, all set by a person |
| Open tasks whose last progress line says they wait on Om (three projects checked) | **18**, none marked in any way a list can find |
| Projects marked active | 34; **19 have no open task** |
| Tasks ever given to Claude through the dispatcher on the live site | 0 |

What the 18 "waits on Om" lines ask for: a go-ahead for production (5), something only Om's hands can do, like sending a
drafted client message or one click in a dashboard (4), a decision (4), something to look at (3), something to hand
over, like a file or a secret (2). One of them has waited 12 days and three tasks hang off it.

**The five problems:**
1. **Work that needs Om is invisible.** The sessions follow their rules ("Blocked, with a reason"), but these tasks are
   not blocked; they are finished up to the point where Om is needed, so they sit In Progress at 90%.
2. **"In Progress" means three things:** being worked on now, built and waiting for release, and abandoned. Percent
   stands in for a state that doesn't exist.
3. **Three ways to say "this is Claude's work", none used** (dispatcher mark, Claude items, the tag). Meanwhile the real
   hand-over happens 200 times a month: Om is in a session and says "do this". Nothing records it, so nothing follows it.
4. **The humans talk somewhere else** (Discord, WhatsApp). None of it enters Work OS.
5. **Nothing is tidied, and two systems each hold half the project list** (Delpat OS and Work OS disagree on which
   projects exist and which are finished).

---

## 5. The core loop

Everything Work OS does should be one step of this loop, a door into a step, or a view of it. Anything else is not core.

```
            doors in: Claude chat, Claude Code, the app, Discord, mail, Delpat OS
                                      |
                                      v
   1 CAPTURE  ->  2 READY  ->  3 WORK  ->  4 NEEDS A PERSON  ->  5 REVIEW  ->  6 DONE
   a task in      who does     a person     one clear ask,        result is     accepted;
   the right      it (person   or a Claude  to one person;        shown; the    weekly tidy
   project        or Claude),  session;     the task parks        asker says    closes what
                  what "done"  progress     until answered        yes or sends  is left
                  means        is logged          |                it back
                                   ^              |
                                   +--- answer ---+
                                      |
            doors out: phone push, Discord DM, mail, the morning brief
```

Three rules follow from it:
- **A task is always in exactly one place:** waiting to start, being worked on, waiting on a named person, or finished.
  "90%" stops being a place.
- **One new thing makes steps 4 and 5 real: a Need.** A short structured ask on a task, addressed to one person: what is
  asked, a real example, the options, the recommendation, and its kind (decide, approve, do, provide, review).
  Questions, production go-aheads, "please send this", "please look at this" and "review my result" are all Needs.
- **Work OS holds the work, not the conversation.** Sessions talk to Om in the Claude app (Remote Control). Work OS only
  knows who has the task, what state, what is asked, and what came out.

---

## 6. The flows (to agree one by one)

Status words: **used** (in real use), **built-unused**, **new**. Each flow ends with "works when" lines that become its
end-to-end test.

### A. Capture
- **A1 Om tells Claude, Claude files it.** *Used.* Claude finds the project, files tasks in one `apply_changes` with
  project, priority, who, a done-when line and a due date if given; long content in a note; marks what it could do
  itself (G1). *Works when:* one call makes 3 tasks in the named project, each with a done-when, actor "claude", and
  they show on Om's Today without a reload.
- **A2 A teammate adds a task in the app.** *Used.* *Works when:* a weekly task assigned to another member sends exactly
  one alert; completing it creates the next one.
- **A3 From a Discord message.** *Built-unused* (one setting away). Right-click "Add to Work OS" or `/task`; the task
  links back to the message and marks its text as written by the Discord author. *Works when:* one interaction makes
  one task with the link; repeating it makes none.
- **A4 From a mail.** *Built on a branch.* Claude turns a mail into a task, its text marked as outside mail, linked to
  Mailloom, no duplicates per Message-ID. Needs Mailloom on the real mail server first.

### B. Knowing what is on
- **B1 Om's morning.** *Used in part.* "What's on?" gives, in order: **Needs you** (with options), **Claude's runs**
  (to review, stopped, stuck), **due and overdue**, **gone quiet** (F2), **Discord and mail that need you**. Om answers
  Needs right there; Claude records the answers. A 09:00 push says "4 need you, 2 to review".
  *Works when:* with 2 Needs, 1 finished run and 1 overdue task, `daily_summary` returns them in that order.
- **B2 A teammate's day.** *Used, minus Needs.* Today shows Needs first, then assigned and due, then in progress. A
  teammate who needs Om raises a Need instead of waiting. *Works when:* a Need raised by a member shows in the owner's
  brief.
- **B3 Phone alerts.** *Built-unused live.* Push by default for four things only: needs you, Claude finished or stopped,
  assigned to you, due today (one digest). Tap opens the exact Need or task. **Everything else depends on this; prove it
  first.** *Works when:* Send test on work.delpat.in reaches Om's phone, Discord and mail; a Need for him gives exactly
  one push.

### C. A Claude session at work
- **C1 A session picks up where the last stopped.** *Used where the repo names its project.* `get_project` by git
  remote returns answered Needs first, then tasks handed to Claude, then open tasks with their last state.
  *Works when:* that order holds; an unknown remote returns "unmatched" with candidates.
- **C2 The session keeps Work OS true.** *Used, with one hole.* Claim, progress (what changed, what's tested),
  discoveries become tasks, **a Need instead of "waits on Om" in a progress line**, a result at the end (G6). Every
  write carries a session label (machine, repo, branch) so sessions can be told apart. *Works when:* two sessions on one
  task show as two in the history; a Claude progress line containing "waits on" gets a reminder to raise a Need.

### N. Needing a person
- **N1 Ask one person one clear thing.** *New* (reuses Claude items' "waiting on Om" screen and the alert pipeline).
  The asker files a Need; the task shows "Needs Om" instead of a percent; one push; the asker moves on. Waiting on a
  client is addressed to whoever chases ("for Om: ask the client X"). *Works when:* a Need shows under "Needs you" in
  the brief and on Today, one alert is queued, a second Need of the same kind replaces the first.
- **N2 Answer from the phone, the work continues.** *New* (reuses Resume). Tap an option or type a line; the task
  un-parks. Then: if Om is in the session, he just says it; if the run is on the PC, the worker resumes that session
  with a fixed line ("your Need on #N was answered, read it") and never the answer text; if the session is gone, the
  task goes back to the queue and the next run reads the answer first (C1). Unanswered after 2 working days: flagged.

### G. Give to Claude
One field on the task: **Claude: could / handed**, plus where it should run (here, PC, cloud). "Working" is the claim,
"needs a person" is a Need, "to review" is a review Need, and "done" is Done: no second set of states.
- **G1 Mark at creation.** *New* (replaces the tag). A session filing a task marks it *could* when the outcome is
  checkable, everything it needs is reachable, and it is reversible (a branch, a draft, a read-only check), with one line
  why. It says which step needs a person ("can build it; Om presses deploy"). *Could* never starts work by itself.
- **G2 "Now hand it over".** *App button built-unused; from a session new.* Three ways: say it in the session ("hand #N
  to Claude", "do the ones you marked"), tap Give to Claude (or "Hand over all"), or a per-project standing rule (off at
  first). Work OS checks the task is ready (project, done-when, no open Need, a linked repo for PC/cloud) or says what is
  missing. In a session, the task can run right there. *Could* tasks nobody hands over for 14 days go to the weekly
  tidy. *Works when:* a ready task becomes *handed*; one with no done-when is refused with the reason; a hand-over from
  a session of a task containing a teammate's text becomes an approve Need (D2).
- **G3 Runs on Om's PC.** *Built-unused* (the dispatcher). Claim once, at most 2 at a time, Claude Code in the linked
  folder with a fixed first line (ref only) and Remote Control; ends with a Need, a result, or a stop with a reason;
  quiet 20 min → one alert, re-queue once. *Works when:* on the live site one small real task handed over from the phone
  starts in its folder within a minute, shows in the Claude app, and ends as *to review* with exactly one push.
- **G4 Runs in the cloud.** *New, last.* One cloud session per task, output a branch and a pull request, never a
  deploy. Needs Dead Drop's unattended approval (#269). *Works when:* with the PC off, a handed task in a cloud-ready
  project produces a PR and a review Need.
- **G5 Follow it from the phone.** *Built in pieces.* One Claude screen, three lists: **Needs you**, **Working now**
  (where, last progress line, how long ago; "Open the session", "Take back"), **To review**. No transcript passes
  through Work OS.
- **G6 Review and accept.** *New.* The session hands in a result: what changed, what was tested and how it rates, where
  to look, what is left. A review Need goes to whoever handed it over. Om picks **Accept**, **Send back** with a line
  (the next run reads it first), or **Accept and file what is left**. Read-only checks and reports finish by themselves
  and show in the brief (D4). *Works when:* `complete_task` by Claude on handed code work gives a review Need, not Done.

**Reuse / drop:** reuse the dispatcher's claim, cap, take-back, fixed first line, reconciler and alerts, and the
worker's start/resume/stop. Change "finished = Done" to a review. Fold Claude items into tasks and Needs, drop the list
and the `claude-code` tag. Freeze the Start modal, VS Code, Reopen all, Claude Desktop and Turbo: one way to start
remains, from the task. Drop the worker's edit of `~/.claude.json` (D9).

### F. Keeping it honest
- **F2 Quiet work is flagged.** *New* (reuses Review › Stale). In the 15-minute check: In Progress with no change for 2
  working days, overdue with no date change, a Need unanswered for 2 days, a claim with no sign of life. In the brief
  and on the task, no push. A task with an open Need is waiting, never "quiet".
- **F1 The weekly tidy.** *New as a flow.* "Tidy up" gives one list: projects with no open task, duplicates, overdue
  tasks, *could* tasks nobody handed over, tasks quiet for 14 days. Claude reads it group by group with a
  recommendation; Om says yes or no; one `apply_changes` with a dry run. *Works when:* applying the answers changes
  exactly those records and the next list is empty.

### E. Team
- **E1 Invite, share, assign.** *Live.* Keep, no new work, except that Needs work for every member.

### X. Other systems, as doors into the same loop
| Thing | Owner | The other side |
|---|---|---|
| Clients, the commercial project record, money, meetings | **Delpat OS** | Work OS keeps a link by id |
| Credentials and env files | **Delpat OS (Dead Drop)** | Work OS holds none, ever |
| Tasks, Needs, results, notes about the work, repo ↔ project | **Work OS** | |
| Sessions and their conversations | **Claude** (app, Remote Control) | Work OS keeps only the run record |
| Detailed repo state | **The repo** (WORK-STATE.md) | Work OS links to it |
| Team talk | **Discord** | Work OS reads; tasks link back |
| Mail | **The mail server, through Mailloom** | Work OS reads and sends with each person's own key, stores no mail |

- **X1 Delpat OS: a client project is born once.** *Built-unused* (import, against a stub; secret not set). Import or
  link an existing project by id; the project page links to the client record. Link, never sync.
- **X2 Delpat OS: a session gets its env without Om pasting.** *Used attended.* Unattended only for projects and
  environments Om ticked (never production); otherwise the run raises an approve Need and parks.
- **X3 Discord: into the brief, alerts out.** *Built-unused.* Mentions, replies and flagged messages in the brief, each
  offered as a task; Needs and results also as a DM if the person turned that on. The bot never posts in channels.
- **X4 Mail: Claude drafts, Om approves, it goes out.** *On a branch; Mailloom not live.* The draft goes in the task's
  note, an approve Need shows recipient and first lines, Send sends once through Om's own Mailloom key and records it on
  the task. When Om is in the session, it just sends (D6). The pattern is already real: drafted client messages wait
  for Om to send by hand today.

### Side uses
- **Keep:** calendar link (one-way), reel publisher (running, no changes), Work OS's own SMTP for resets and invites.
- **Freeze:** AI tools for Cursor/Antigravity/ChatGPT, chat backup (#168), two-way calendar, cross-session messaging,
  the long-running cloud dispatcher, plugin hooks beyond start and stop.
- **Cut:** schedule / day plan / page tint / timetable, Claude items as a list, the `claude-code` tag rule, paste
  import, the dead code in WORK-STATE Later.

---

## 7. Build order

**First, Om's hands only (about an hour):** Send test on the live site (B3); the Discord Interactions URL; backups;
the decisions below.

| Step | What | Flows |
|---|---|---|
| 1 | **Needs**: the ask, "Needs you" on Today and in the brief, one push, answer from the phone; turn today's "waits on Om" lines into Needs | N1, N2, B1, B2 |
| 2 | **Quiet flags and the weekly tidy**; run the first tidy | F2, F1 |
| 3 | **The mark and hand-over "here"**, the session label, results and review; fold in Claude items and the tag | G1, G2, G6, C1, C2 |
| 4 | **The PC lane proven once live**; answers resume sessions; the one Claude screen | G3, G5, N2 |
| 5 | **Doors**: mail tools once Mailloom is live, Delpat OS link, Discord and mail in the brief | A3, A4, X1, X3, X4 |
| 6 | **The cloud lane**, after ten real PC hand-overs and Dead Drop's unattended approval | G4, X2 |

**The smallest set that makes Work OS worth opening every day:** A1, B1, N1 + N2, C1 + C2, G1 + G2 "here" + G6, B2, B3.
That is steps 1 and 3 plus a push that works. No dispatcher, no cloud, no integration, and it fixes the two things the
data shows most: work waiting on Om that he can't see, and "90%".

**Later (3 to 6 months), by value:** the overnight queue (hand over five tasks at night, review at 09:00); recurring
tasks that Claude does (post-release checks, monthly client updates); a drafting desk for everything that goes to a
client; "catch me up on project X" in ten lines; one inbox across Discord, mail and Work OS; meetings become tasks;
teammates hand work to their own Claude; a weekly view of the workforce (runs, accepted first time, sent back, wait on
Needs). The measure for all of it: **tasks a week that go from handed to accepted without Om opening a laptop.**

---

## 8. Decisions for Om

| # | Question | Recommendation |
|---|---|---|
| D1 | One "Need" for every kind of waiting, or separate questions / approvals / reviews? | **One Need with a kind.** One list, one push, different buttons. |
| D2 | Who may say "hand it to Claude" outside the app? | **A session may, when every word of the task was written by Om or his own Claude;** a teammate's, Discord's or a mail's text turns it into a one-tap approve Need. Standing per-project rule off until ten hand-overs went well. |
| D3 | Permission mode for handed-over sessions on the PC? | **Edits accepted, plus a short per-repo allow list** (its test, build, git); anything else asks via Remote Control and becomes a "stuck" push after 20 min. Never skip-all. |
| D4 | May Claude mark handed-over work Done itself? | **Review for anything that changed code, data, or went to a client;** read-only checks finish by themselves. |
| D5 | Which system owns the project list? | **Delpat OS owns the client/commercial record, Work OS the working project; link by id, no sync.** Internal and personal projects only in Work OS. |
| D6 | May an unattended run send mail outside? | **No: unattended sends become an approve Need.** In a session with Om present, it sends. |
| D7 | Cloud: one session per task, or a long-running dispatcher? | **One per task first.** |
| D8 | Fold Claude items into tasks? | **Yes**, move the 7, drop the list. |
| D9 | Should the worker keep editing `~/.claude.json`? | **No.** Om accepts the trust prompt once per folder; the worker reports "needs trust". |

---

## 9. How we work from here

1. **Agree** sections 5, 6 and 8: cut, merge, add. Each agreed flow keeps its id.
2. **Write each agreed flow** in `docs/flows/<id>.md`: the person, the steps, and the "works when" checks.
3. **One test per flow** in `tests/flows/`, driving the real app (browser and MCP) end to end. A flow is done when its
   test passes **and** a real person has used it once on work.delpat.in.
4. **Stability rule:** a change to Work OS must name the flow it serves (or a bug in one). Anything else goes to Later.
   No new flow without agreeing it here first. Frozen features get no work.
5. Fix the must-fix list in section 3 first; it is not a feature, it is safety.
