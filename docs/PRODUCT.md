# Work OS: what it is for (draft for Om and Claude to agree)

Status: **draft, 14 Nov 2026.** Nothing here is agreed yet. Once a section is agreed it gets marked `Agreed` with the date,
and from then on work on Work OS has to serve an agreed flow (section 5).

Detail behind this page (read-only review, 14 Nov): the feature inventory and the history/status report, kept outside
the repo because they name clients and people.

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
| **Om** (owner) | Almost only through Claude: plans and files work in claude.ai chat; Claude Code sessions log his client work. ~10 changes made in the app himself in the last two weeks. Reads on the phone. |
| **Akash** (teammate) | The most hands-on app user: creates tasks, assigns himself, recurring tasks, blocks, reopens with a comment. Also uses Claude chat for his projects. |
| **Claude Code sessions** (Om's PC) | The biggest writer: progress lines, checklists, completions, drafts for Om, mostly on client work. Good where the repo follows the boilerplate; elsewhere tasks are left at 90% with "waits on Om" in the text. |
| **claude.ai chat / cloud Claude Code** | Planning and filing tasks for Om and Akash. Recorded as "claude", not told apart from each other. |
| **Server** | Alerts every 15 min; reel publisher (installed 12 Nov, not used yet). |
| Discord | Nothing since 1 Oct (commands never pointed at the new server). |

**In practice Work OS is two things today: Claude's logbook for Om's client work, and Akash's task list.**

---

## 3. What exists today, by real status

**Used for real**
- Tasks and projects through Claude (MCP: add, update, log progress, complete, notes, apply_changes).
- Tasks in the app for Akash: create, assign, status, recurring, block, archive, comments.
- Subtasks (used by Claude for #259). Recurring tasks (Akash: monthly GST, weekly data download).
- Notes (written by Claude sessions as handovers and client context).
- Team: sign-in, invites, shared/private projects, roles.
- Morning brief (`daily_summary`), project picture (`get_project`).

**Live but never tried by a person**
- Several assignees, sharing with chosen people, live refresh (Akash asked to try, 12 Nov; no reply yet).
- Calendar link (ICS), Settings › AI tools (only Claude Code tested).
- Alerts on the live site: push, Discord DM, email (only tested against fakes).
- Reel publisher (installed and self-tested by cutroom; no real reel yet).
- OAuth connection for Claude (some claude.ai connection works; which way is not recorded).

**Built, never used**
- **Starting Claude from Work OS, 7 ways:** Start Claude (terminal + Remote Control), Resume, Open in Claude Code
  (task), Open in Claude Desktop (task), Open in VS Code, Reopen all, Turbo (clone and start). Only Start was tried
  once (15 Oct).
- **Dispatcher (Give to Claude):** one run on a demo copy (17 Oct), never on production.
- Claude items (C-numbers): only in the Work OS project, untouched since 16 Oct.
- Discord slash commands, Delpat OS import, backups to R2, GitHub Actions build, schedule/day plan.

**Designed, not built**
- Agent fleet (#259): needs-Om queue, staleness flags, session identity, plugin hooks, messaging, cloud dispatcher.
- Chat backup (#168), two-way Google Calendar, Dead Drop for cloud sessions (#269).

**Must fix whatever we decide (risks found in the review)**
1. **No backups in production.** The only copy of the data is Atlas.
2. **Deleted notes can't be recovered** after the Undo toast (no trash, no restore) and are never purged.
3. **The worker edits `~/.claude.json`** on every folder link: the same file that was wiped once.
4. HANDOVER.md still describes Vercel and old screens; anyone reading it gets the wrong picture.
5. Dead code and unused dependencies (status panel, theme toggle, timetable API, nginx, react-markdown, ...).

---

## 4. Proposed use cases (to agree one by one)

Each one is a flow: who does what, step by step, and how we know it works. My recommendation is next to each:
**Core** (Work OS must do this well), **Keep** (works, leave it, no new work), **Freeze** (hide or stop working on it
until a core flow needs it), **Cut** (remove).

### A. Capture: work gets into Work OS
- **A1 Core.** Om tells Claude about work (chat or Code); Claude files tasks and notes in the right project, with
  dates and who does it, without Om opening the app.
- **A2 Core.** A teammate adds and updates their own tasks in the app, on laptop and phone (incl. recurring).

### B. Know what is on
- **B1 Core.** Om asks Claude "what's on?" and gets: what needs his decision first, then due/overdue, then what moved.
- **B2 Core.** A teammate opens Today and sees their own work (assigned to them, due, overdue).
- **B3 Core.** The right person gets an alert on their phone for: assigned to you, due, overdue, unblocked, a
  question for you. Proven on the live site.

### C. Claude works in a repo (the heart of it)
- **C1 Core.** A Claude Code session started in any repo finds its project and picks up where the last one stopped
  (open tasks, last state), without Om re-explaining.
- **C2 Core.** While working it keeps Work OS true: progress, completion, notes; what it finds goes on a list instead
  of being chased.
- **C3 Core.** When it needs Om it files one clear question (plain words, example, options, recommendation). Om
  answers from the phone. The session, or the next one, continues from the answer.
- **C4 Core.** Work OS shows which session did what, and flags work that stopped moving (stuck at 90%, overdue not
  moved, In Progress with no update).

### D. Om hands work to Claude
- **D1 Decide.** Start a Claude session on a project from Work OS. Today there are 7 ways; we pick **one** default
  and freeze the rest. My pick: **Claude Code with Remote Control** (you can follow it from the phone), opened from the
  task. Claude Desktop and VS Code: freeze until one of us actually wants them.
- **D2 Later.** Give a task to Claude and it gets done unattended (dispatcher, PC or cloud). Only after C1 to C4 work
  every day; until then it stays frozen.

### E. Team
- **E1 Core.** Invite a teammate, share a project (everyone or chosen people), assign a task to several people, see
  what others and Claude did.

### F. Keep it honest
- **F1 Core.** Once a week: finished projects closed, stale tasks resolved or dropped, overdue dates moved. Work OS
  makes the list; Om says yes or no.

### G. Side uses
- **G1 Keep.** Calendar link (one-way). **G2 Keep.** Reel publisher for cutroom.
- **G3 Freeze.** Discord commands and Discord reading, Delpat OS import, AI tools for Cursor/Antigravity/ChatGPT.
- **G4 Cut.** Schedule / day plan / page tint (left from Om's personal setup), Claude items as a separate list (fold
  into tasks), paste import (Claude does this better).

---

## 5. How we work from here

1. **Agree** sections 1, 2 and 4 together: cut, merge, add. Each agreed flow gets an id (A1, C3, ...).
2. **Write each agreed flow** in `docs/flows/<id>.md`: the person, the steps, and "works when" checks a test can run.
3. **One test per flow** in `tests/flows/`, driving the real app (browser and MCP) end to end. A flow is done when its
   test passes **and** a real person has used it once on work.delpat.in.
4. **Stability rule:** a change to Work OS must name the flow it serves (or a bug in one). Anything else goes to Later.
   No new flow without agreeing it here first. Frozen features get no work.
5. Fix the must-fix list in section 3 first; it is not a feature, it is safety.
