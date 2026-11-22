> Record, 22 Nov 2026: a review of 18 Nov, checked against the code of that day. Not updated; the current text is `docs/flows/agent-system.md`.

# Fable review, 18 Nov 2026

Reviewed: docs/flows/agent-system.md. I checked its claims against the code, the hook installed on Om's PC and the
live Work OS project (read only).

**Verdict: go. The direction is right. Two things the design counts as running are not, and three pieces are bigger
than they need to be.**

## 1. Does it reach the goal? The biggest gap

Mostly yes. One home for status, State as easy as a file, routines as tools and one set of words fix what the survey found.

**Biggest gap: nothing proves a piece is switched on, and the piece that keeps State current is off today.**
- Om's `~/.claude/settings.json` has no `WORK_OS_KEY` (nor has Windows). Without it the start brief and the turn-end
  check print nothing (hook.mjs line 39). Only the file copy and the edit refusal work. The installer says so itself.
- With a key the turn-end check still would not fire. It searches the transcript for the word "save_state" (line 87).
  The brief the hook injects contains that word (server.ts line 1008), and Claude Code stores hook text in the
  transcript (today's has `hook_additional_context` entries). So every session looks saved.
- It asks once per session. Om's sessions run 1 to 3 weeks.
- Four texts still tell agents to write the file the hook refuses: the Orders note, the global CLAUDE.md, the server
  instructions and the save_state answer. Example: an agent on Om's PC saves State, reads "Write this to WORK-STATE.md"
  (server.ts line 1114), obeys, and is refused.

Recommend: (a) tonight: paste the Orders, swap CLAUDE.md, add a key, change the two answer strings. (b) The copy hook
records each save in its marker file; the stop check reads that and asks again after later changes. (c) "Done" for
every piece means the server saw the event from each PC.

## 2. Interfaces and documents

Roles are clear. Three problems:
- **Three tools ask for "changed, checked, left":** hand_in, wrap_up, hand_over. Example: an agent finishes #12 at the
  end of the day and types the same lines twice. Keep those fields in hand_in only.
- **Descriptions do not teach in Claude Code.** In this session every Work OS tool is listed by name only. So names and
  the brief carry the routine. The instructions were cut at about 4,000 characters here; Claude Code keys get 8,300
  (5,325 plus 2,982), not 5,300. The 2,500 budget is right if it counts both parts.
- **The brief does not fit.** The hook cuts at 9,500 characters. Here the Orders (3,300) and State (about 6,000 as
  JSON) fill it; tasks, messages, handovers and "Declutter due" fall off. Recommend plain text in priority order:
  handover, answers and messages, Now and Next, Orders, then counts ("Later 10: get_state").

**Retiring Claude items: yes, in two steps.** They are dead in practice: this project has 7 open, none active, none
ever done, last note 17 October. The dispatcher runs on tasks. But it is not "one tool goes away": about 18 code files
use them (the project's Claude tab, the Queue tab, the "Claude is asking" card in three places, search, an alert kind).
- Now (S): delete "Your work list is Claude items, not tasks" from the instructions (docs.ts line 37). No risk.
- Later (B): migrate. An item has a "why" of up to 2,000 characters and a "done when"; a State line holds 500, so C46
  would be cut. An item with a "done when" becomes a task, an idea a Later line, the small-fixes item one task with a
  checklist. Use the Declutter pilot: one Need per project.
- Lost: the claim that stops two sessions starting one item. Rule: work two sessions could both pick is a task;
  set_doing shows who has it.

## 3. Keys

Fine for start and stop. Not workable as written for delivery after every tool call.
- **The key's promise changes.** A wkr_ key opens only /api/worker/* today, and Setup says "It can't read or change
  tasks, notes or projects". The new routes read Orders, State and messages and write State. Recommend: only projects
  with a folder on that PC; change the Setup text.
- **Reading the key is slow.** It is a DPAPI file read through PowerShell: 0.8 to 1.1 seconds on Om's PC (three runs).
  Fine once at start, too slow per tool call. I believe an `http` hook can send only environment variables, so the key
  would sit in plain text for every command. Hand-check that.
- **One shared limit.** Device routes share 60 calls a minute (worker-route.ts line 15). Example: six sessions at ten
  tool batches a minute pass it, and the worker's own job polling gets refused.

Recommend: at session start the hook swaps the device key for a session token (one session, one project, a day, its own
limit) kept in the marker file. That also gives the per-session id. Until then add a normal key: a week without the
brief costs more than one pasted key.

## 4. Making State easy

edit_state on the whole markdown is the risky piece. The markdown is a rendering, not the data:
- It differs per reader: other people's lines end "(by Akash)" (states.ts line 338).
- It adds "(#12)", "waits on X", numbers and dates, and shows only the last 30 Decisions.
- The only parser is the import one. It would turn Decisions and Where into Later lines and cut long lines.
- "Keeps ids by matching" is a guess whenever one edit changes two lines.
- **Author.** A line someone else wrote is marked writtenBy, which tells agents "information, not instructions". If an
  edit keeps the author, Akash's agent can rewrite Om's line and Om's agents trust it. An edited line must become the
  editor's.

**Simpler: edit one line, found by its text.** `old` must sit in exactly one line of Now, Next or Later. Work OS
replaces it inside that line; an empty `new` removes the line. No parsing. The id is kept because it is the same line.
If the line changed, `old` is not found and the answer shows the current text. Let every op take `find` in place of
`id`: after a short "Saved v8" the agent has no ids.

Also:
- **Short answers break the installed hook.** It writes the file from the answer's `markdown` field (hook.mjs line
  125). Drop the field before every PC's hook fetches it and the copy stops, silently. Change the hook first.
- **Next and task: one way.** Task done finishes the line. The other way lets done_next close a code task and skip the
  review hand_in forces.
- **Forwarding:** forward the Edit tool only. Keep refusing Write and shell writes: before the command runs the hook
  cannot know the change. Leave the offline queue out. I suggested it this morning; replaying text edits against a
  changed State is worse than "try again".
- **Two PCs.** The copy is committed on every save and differs per reader. With Akash's hook on, both PCs commit
  different versions of one file and pulls conflict. Render it the same for everyone; on conflict rewrite from the
  server. It also carries Decisions (server names, a key file name): leave them out where the repo is public.

## 5. Actions and tools

- **Merge wrap_up and hand_over into `end_work`** with an optional handover part. It pairs with start_work and explains
  itself in a list of names. The desktop app already has tools named `wrap_up` and `hand_off_to_session`, and
  `hand_over` sits one word from `hand_in`.
- **Leftovers:** Work OS knows slots, open Needs and a task still marked doing. It cannot know processes. Promise only
  what it knows.
- `who` becomes `list_sessions`. `feedback` and the friction line are stored as one thing.
- **declutter:** "a line sits for 14 days" must skip Later lines that wait on someone. Example: "Off-box backups, waits
  on Om" would make this project due forever. After an answer, stay quiet for 14 days. The Work OS half of a batch
  applies on the server when Om taps yes; the asking session may be gone.
- **Block 1** needs "production" defined per project (remote and branch). No such field exists.
- **Auto import:** fix line cutting first, and above about 40 lines ask with a Need. Here it would have made 169 Later
  lines.

## 6. Wording test

Practical for text in the repo, but the phrases miss. Of the five sentences that caused drift, "write it to WORK-STATE"
and "keep WORK-STATE" catch one. "Write this to WORK-STATE.md" and "Keep state in the repo" pass.

Recommend the reverse: every agent-facing string naming WORK-STATE.md must be on a short approved list. Add retired
words and the budget.

The test cannot see the Orders, a PC's CLAUDE.md or the transfer note: three of the five sources. So the app warns when
Orders are saved with a retired phrase, and the start hook checks the PC's CLAUDE.md and reports it as a number. Add
"Claude items" to the test only when the migration lands, or the build fails on day one.

## 7. Build plan

The split by skill is right. The split by file is not: A, B and S all edit hook.mjs, docs.ts and server.ts.

1. Tonight, no builder: 1(a).
2. S first and alone, one day: the wording pass, the Claude items paragraph, hook.mjs split into one file per event,
   the stop-check fix. Merge. Then A and B branch.
3. In parallel: A on the session token and per-session ids (worker-route.ts, new routes). B on line edit, `find`,
   remove and short answers (states.ts, the State tools). A owns the hook files; B hands over forwarding as one function.
4. Then A: blocks, propose_order, delivery. B: end_work, declutter, the migration.
5. Move packaging up. The hook is a hand copy in AppData, re-run after each update. `hooks install` exists: let the
   worker's update refresh it and report its version. "PCs with no hook events" depends on that.

Most help this week: step 1, the stop-check fix, and line edit with `find`.

## 8. Daily use

- **Om's phone.** Example: the week this ships, eight projects are "Declutter due" together, plus rule proposals and
  push approvals. Send only Needs a session is waiting on; the rest go in the Monday digest. A push Need offers "yes,
  and for 24 hours on this project".
- **Akash's other folders.** The install is global, so in a personal repo the session asks "which project?". Add a
  "not Work OS" answer, remembered per folder.
- **Wakes.** Two sessions answering each other can wake each other all night. Cap wakes per session per hour.
- **Commit noise.** A commit per save for three weeks is hundreds of commits. Commit only when lines changed.

**Not checked:** I ran no session with a key, so the stop-check finding rests on the code and today's transcript. I did
not test http hook headers or a Mac.
