# How Om and his agents work: Fable review (18 Nov 2026)

**Verdict: go, but smaller and in a different order.** Most of what you need is built and not switched on. Switch it
on, fix the rulebook, make saving State cheaper than editing a file. Build the rest only if the numbers ask.

## 1. Is the diagnosis right?

Right, but it stops one step short. These causes sit under "rules in four places, nothing checks".

1. **The rulebook Work OS serves is wrong.** The live org Orders (note 785391c151, 14 Oct) still say "Detailed state
   lives in the repo's WORK-STATE.md". Every session that called start_work was handed that. The 5 of 8 did not
   drift. They obeyed.
2. **The check exists and is not installed.** `worker/hook.mjs` (15 Nov, tested against the real server) injects Orders
   and State at start and after compaction, and blocks once at stop when files changed and State was not saved. Om's
   `~/.claude/settings.json` has no hooks and no Work OS key. The enforcement draft plans A1 and A4 as new work: a
   tool rebuilt. Root cause: done means merged, not "running on Om's and Akash's PCs".
3. **The start line does not reach agents.** "Start here: call start_work" is in the server instructions only for
   Claude Code keys, after about 5,500 characters of task, Discord and mail detail. In this review session the
   instructions were cut off before it. claude.ai chat is never told.
4. **The right way costs more than the wrong way.** Editing a file is one step. save_state needs ops, cannot edit or
   remove a line, and import cuts long lines. Proof: this repo's WORK-STATE.md has 30 hand-kept lines headed "not in
   Work OS". The copy is already a second source, in Work OS's own repo.
5. **Om is the transport for rules.** A correction lands in one chat and one project's memory; the other seven sessions
   never hear it. Nothing retires an old rule: global CLAUDE.md says "No Haiku" and "at most 2", two memory files say
   the opposite. Orders are hand-edited in the app only, so they sat untouched for five weeks while 12 memory rules grew.
6. **Rules leak at hand-offs.** Phase 3 skipped Work OS because "its brief said the doc was its only output". Cutroom's
   builder synthesised sound because the brief left out 120 licensed SFX. Briefs, peer messages (the orchestrator's
   HALT) and the transfer-protocol note are three more rulebooks.

One problem is a different kind: guesses reported as causes, "done" without testing. No hook fixes that (section 7).

## 2. Document roles

| Document | Holds | Written by | Never holds |
|---|---|---|---|
| Global CLAUDE.md (per PC) | Five bootstrap lines; facts about this PC | The PC's owner | How to work, status, project facts |
| Orders: org | How every Delpat agent works; 40 lines at most | Om in the app; agents propose through a Need | PC facts, status, one project's rules |
| Orders: project | Rules only this project needs (cutroom: one Blender) | Project owner | General rules |
| Orders: person | How that person wants to be talked to | The person | Work rules |
| State | Now, Next, Later, Decisions, Where | Agents with save_state; people in the app | Rules, how-tos, history ("build X went live") |
| Tasks | Work someone tracks: owner, due date, review | Agents and people | A copy of every Next line |
| Notes: Overview, Designs, Runbooks, Archive | What people read | Agents and people | Status |
| Notes: Handover | One page per live session, overwritten, archived once read | The Transfer action | What State, git and docs hold |
| Repo CLAUDE.md / AGENTS.md | Project name, code rules, "what exists here" | Agents, in git | Status, how to work |
| Repo docs | How the code works | Agents, in git | Plans, status |
| WORK-STATE.md | A generated copy of State | The plugin hook only | Anything typed by an agent or person |
| Memory | Facts; corrections waiting to be proposed | Claude's memory feature | Standing rules, status |

**Merge, drop, rename.**
- Rename "Claude Code boilerplate" to "Delpat Orders" and paste the draft in today.
- Drop TRANSFER.md and _FLEET.md. Drop the fleet index note once the plugin shows live sessions: it is a hand-kept copy
  of the Workers tab. Fold the transfer-protocol note into the Transfer action.
- The tool index (B3) changes with the code, so it lives in AGENTS.md, not a Work OS note. Machine things (the SSH
  entries Mailloom missed) go in global CLAUDE.md.
- Memory: I disagree with "facts only, never rules". Claude's own memory feature saves corrections whatever we write.
  Treat memory as the inbox: Wrap up turns each new correction into a proposed Order. Of this project's 12 memory
  files, 8 are rules already in the draft Orders and 4 are project facts. Move them.

**How the copy stays a copy (revised: no agent step).** The agent's only job is to call save_state. It never opens
WORK-STATE.md. Replace "write save_state's markdown into it" in the draft Orders, enforcement A1 and the MCP
instructions ("save_state returns the text").

1. save_state answers with one line, not the full text. That saves about 1,500 tokens a save.
2. The plugin's after-tool hook sees the save, fetches State with its own key and writes the file in the project's
   main folder. First line: "Copy of Work OS State v7, hash 3fa9. Written by Work OS. Do not edit."
3. The same hook commits that one file alone (`git commit --only WORK-STATE.md -m "State v7"`), so the agent's staged
   work is untouched. During a merge or rebase, or on a detached HEAD, it skips and retries at the next save. It never
   pushes; the copy travels with the next normal push.
4. Builder worktrees are skipped. Otherwise two branches change a generated file and every merge conflicts.
5. Session start runs the same check. If the file is behind the server (Om edited State on his phone, a chat session
   saved, Akash saved from his PC), the hook rewrites and commits it.
6. Any Edit or Write to the file is refused, always, naming save_state. If a person or another tool changes it anyway,
   the hash no longer matches: the next start rewrites it from the server and shows the lost lines once.

**When Work OS is down.**
- Reading: today the hook prints nothing when it cannot reach the server, so the session gets no rules and no State.
  Change: the hook caches the last Orders outside the repo and injects them with the file: "Work OS unreachable. Copy
  of v6, 3 hours old."
- Writing: save_state fails. The failed-tool hook stores the call's ops in a queue outside the repo, adds a
  machine-written "Waiting to be sent" block at the bottom of the file, commits it, and tells the agent "Queued; carry
  on." When the server is back the hook replays the ops and rewrites the file; the block is gone. A replay that does
  not apply becomes a line in start_work.
- If the MCP connection itself dropped (Phase 3 non-chat, 18 Nov), the stop check names the plugin's one command that
  saves through the same queue.

Hand-check first: that after-tool and failed-tool hooks fire for MCP tools and carry the call's input (not checked).
**Trap:** the first automatic write would erase the 30 "not in Work OS" lines here, and the same in other repos. The
first write per repo must refuse and list the lines that exist only in the file.

## 3. The five-part plan

**Right:** one rulebook; injecting it at start and after compaction; refusals that say what to do; approvals as Needs.

**Overbuilt:**
- The enforcement table has 30 rules, most enforced by guessing at shell text. B1 nudges on the word "probably". F3
  refuses new root files unless on an allow-list, which Om ruled out on 30 Oct. Guesses misfire, and agents go around
  them. Keep a block only
  where the action cannot be undone and the test is exact. Three qualify, and four of seven sessions asked for them:
  push, tag or release to production without an answered Need (AKAR); a production-linked CLI not aimed at the test
  target (Phase 3 overwrote two secrets); writing WORK-STATE.md.
- Strengths, per-rule counters, the adoption card and a weekly verdict on each rule are governance for 35 lines and
  two people. Om will stop answering by week three. Replace with one Monday digest block: four numbers and at most
  three proposals. Silence means keep.
- Friction detection from call patterns: later. The survey got better data for free. Put its best question in Wrap up:
  "What got in your way? One line or none."

**Missing:**
- Install, and knowing who has not. start_work should say "no hooks seen from this PC".
- Orders changing under open sessions. Om edits a rule; eight open sessions keep the old one. Give Orders a version;
  a change shows in forYou and the hook re-injects.
- A capture path. `propose_order` files a Need with the old and new line; Om taps Accept on his phone. Without it, "a
  correction given twice becomes a rule the same day" has no mechanism.
- One in, one out, inside the 40-line budget.
- Subagents: the plugin injects a ten-line short form of Orders at subagent start, so rules stop depending on the brief.
- Messages carry work, never rules.
- Surfaces with no hooks (chat, Cursor, Antigravity) get only server instructions and tool answers. Make "call
  start_work first" line one for every key; move Discord and mail detail into those tools' descriptions.

**The simpler design (80%):** one correct rulebook served everywhere; the existing hook installed, plus the copy-writer
and three blocks; State cheaper than a file.

## 4. Actions

**Set:** Check in (start_work, exists), Wrap up, Transfer, Declutter. Drop "Review rules": it is a screen for Om, not a
routine for agents.

**Delivery: MCP tools whose answers carry the routine.** Only tools reach every surface, and only tools can be called
by an agent working alone. MCP prompts are picked by a person from a menu; a session left running at 3 am never picks
one. Plugin skills exist only in Claude Code and keep the routine's text on disk, where it goes stale. So each action
is one tool, and its answer says what is left. Example: `wrap_up` takes the State ops, changed / checked / left
and the friction line, and answers "Saved v7. You still hold 1 heavy slot. Need #41 is open." One call replaces
save_state, hand_in and a file edit. Add prompts only as one-line aliases ("call wrap_up and follow its answer") so a
person can tap them in chat.

**Transfer (Akash's ask):** `hand_over` with short capped fields: the exact step, tried and dropped, why, children, for
whom. Capped fields make "pasted whole, not a delta" (Grant Leads) impossible. The next start_work on that project, in
any tool or account, shows it first: "Handover from Om's Claude Code session, 12 minutes old." Reading archives it.
This is option 1 of Akash's chat-porting design; tools without MCP use its paste import.

**Declutter:** as drafted, but on demand and monthly. Every Sunday on ten projects is ten Needs a week.

## 5. How agents come to like it

An agent takes the shortest path and follows what is nearest in its context. So the right path must be the shortest,
and the payoff must arrive at the moment of choice.
- start_work pays in its first answer: where things stand, what was tried and dropped, who else is in this repo and on
  which branch (a Grant Leads builder hit a branch in use), what exists here. One call instead of ten.
- A Need gets answered. A question at the end of a turn waits hours; a Need reaches Om's phone. Show it back: "Need #41
  answered in 6 minutes."
- State is the agent's memory after compaction. The Sonnet test session lost its regex and its list of finished cases.
- Fix what punishes first: note edits failing on curly quotes, import cutting lines, no line edit, messages unread
  forever. Each one teaches an agent to go back to a file.

The test of pull: do sessions with no hooks (chat, cloud) check in and save unasked?

## 6. Build order and what to measure

1. Today, Om, 20 minutes, no code: paste the new Orders; swap the global CLAUDE.md; install the existing hook on both PCs.
2. Builder S, two days: instructions line one; Orders version in forYou; State line edit and remove; move this repo's
   30 lines into State.
3. The copy-writer: write, commit, refuse edits, offline queue and cache (after the hand check).
4. Week 1: package it as the plugin (folder decides the project, three blocks, subagent short form). Presence and
   message delivery follow in the settled order. Then `wrap_up` and `hand_over`.
5. Week 2: `propose_order`, the Monday numbers, memory rules moved, Declutter's server half.
6. Later, only if the numbers ask: friction detection, strengths, more blocks.

**Measure for two weeks (counted by server or hook, zero tokens):**
- Sessions that changed files and saved State before stopping: 3 of 8 today, target 9 of 10.
- PCs with no hook events; org Orders still at 40 lines or fewer.
- Refused WORK-STATE.md edits and hash mismatches: near zero by week 2. If refusals stay high, saving is still too hard.
- Om's repeats: each repeated correction is filed with `propose_order` marked "repeat". It should fall every week.
- The same seven-question survey again on 2 Dec.
- The goal itself: on three random days Om opens five projects on his phone and asks each session "does this match?"

## 7. Risks

- **Token cost.** Orders plus State at each start and compaction is about 2,000 tokens: small. Watch instead: the hook
  cuts its brief at 9,500 characters, so keep Orders under 4,000; this session lists the Work OS tools twice (a second
  identical connection; not checked which key it uses); auto-compaction at 40% multiplies drift until the hook
  re-injects.
- **Friction for Om and Akash.** Review Needs, push approvals, declutter batches and rule proposals all land on one
  phone. One Need per release covers push, tag and release; the digest batches the rest. For Akash: one install
  command, hooks fail open, every block says how to lift it.
- **Gaming.** Agents meet the letter. A trivial save_state passes the stop check; "checked: yes" passes hand_in;
  TRANSFER.md becomes notes.md. So: few exact blocks, no word detectors, and check results, not wording. hand_in's
  "checked" should hold the command and its result line, and the reviewer samples it. That is also the only real answer
  to guesses reported as causes.
- **A pile again.** The budget; one in, one out; each rule carries its date and incident ("Cutroom, 18 Nov"); a monthly
  proposal to drop rules with no incident in 60 days. Do not paste enforcement.md's 30 rows into Orders. docs/flows
  now has three overlapping designs: fold them into one after Om decides.
- **Trust.** Orders are the highest-trust text an agent reads. Keep them app-only; `propose_order` never applies
  itself. When more people join, a project owner's Orders will steer other people's agents: decide then.
