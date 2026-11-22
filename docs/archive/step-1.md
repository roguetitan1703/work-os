> Record, 22 Nov 2026: design of 14 Nov. Built (State, Needs, messages, Orders, the start brief), then changed by the Harness and Identity work; what exists now is in `docs/HANDOVER.md` and `docs/flows/agent-system.md`.

# Step 1 design: project State, the brief and the inbox

Status: **design, 14 Nov 2026, for Om.** Serves flows S1, S2, S3, H1, MS1–MS4 in docs/archive/product-14-nov.md (section 7). The
goal of step 1:
- any agent, in any AI, on any machine, can start on a project and lose nothing;
- an idea or a message dropped from a chat reaches the next session on that project.

Done means each flow's test in `tests/flows/` passes, **and** cutroom and Work OS run on it for a week.

## What gets built

### 1. State (new collection `states`, one per project)
| Field | What |
|---|---|
| `now` | `{ text, holder? }`: one goal; holder = the session label that set it |
| `next` | ordered `[{ id, text, ref?, waitsOn? }]`; `ref` = a task number, `waitsOn` = a person (filled from Needs in step 2) |
| `later` | `[{ id, text, waitsOn }]`: one line each, with what it waits on |
| `decisions` | `[{ id, at, by, via, text }]`: append-only; `by` = who decided, `via` = chat / code / app / discord |
| `where` | per machine: `{ branch, head, dirty, worktrees, at }`, written by the agent from git output |
| `version` | an integer, bumped on every write |

- **Who can see it:** the project's own readers, through the scoped door. The door filters each document by its own
  `ownerId / visibility / sharedWith` (lib/scope.ts), not through the project, so a State row is **stamped with its
  project's placement** and added to every place that moves placement today: the cascade in `setProjectPlacement`
  (lib/data/projects.ts), `takeOffLists`, and project delete. Same for `messages` and `presence`. New leak-audit
  entries for every read and write, including: write State, make the project private, read it as a teammate (refused).
- **Writing:** `save_state(project, ops, base_version?)`. The ops are set_now, add_next, move_next, done_next,
  add_later, promote_later (it becomes a task), add_decision, set_where. **Only set_now, move_next and done_next need
  `base_version`**; if it is stale, nothing is written and the current State comes back, and the agent merges and
  retries. Appends (add_next, add_later, add_decision) and set_where (keyed by machine) go through `$push` / `$set`
  and never clash. Every write bumps `version`.
- **Who writes:** any agent may append; set_now, move_next and done_next are for the orchestrator of the project
  (docs/archive/product-14-nov.md 6.1: builders report on their tasks, they don't rewrite State). Decisions and Next lines written by
  someone other than the reader reach the reader labelled `writtenBy`, as information.
- **The repo copy:** `save_state` returns the markdown for WORK-STATE.md, headed with the version it came from
  ("Copy of the Work OS state, version 41. Edit it in Work OS"). The agent writes the file and commits it with the work.
- **Import, once:** if a project has no State, `start_work` says so. The agent then calls
  `import_state(project, markdown)` with the repo's WORK-STATE.md, and its Now / Next / Later sections are parsed.
  Anything that doesn't parse goes into Later as plain lines, so nothing is lost.
- **In the app:** a State card at the top of the project page, with Now, Next, Later and Decisions, editable. The
  same card on the phone's project screen. Edits made in the app use the same versioned writes.

### 2. Orders (standing rules served to every AI)
- **Three layers:**
  - **organisation:** the existing "Claude Code boilerplate" note becomes it;
  - **project:** a note on the project marked as its Orders;
  - **person:** a note of the person's own.
- A note becomes Orders through a new `orders` field. Only the owner (organisation layer) or the project's owner
  (project layer) can set it, because Orders steer every agent.
- **An Orders note's body is edited by a person in the app only.** MCP writes to it are refused, for every key
  (today's lock covers only the dispatcher's own boilerplate, lib/data/notes.ts). Otherwise one prompt-injected agent
  could rewrite the rules every agent follows.
- `start_work` returns all three, joined, labelled with who wrote each. Project Orders written by someone other than
  the reader's own person arrive labelled `writtenBy`, as information, not as rules.
- The work class rule (think → Opus, do → Sonnet, chore → Haiku) goes into the organisation Orders.

### 3. `start_work`, the brief (new MCP tool)
- **Input:** the project (name or id), or `remote` + `branch` + `path`, as `get_project` accepts today (its repo
  matching is reused). Also `machine`, a short name, and `label`, e.g. "cutroom prime, Opus, main".
- **Output, in this order:**
  1. **Orders.**
  2. **State.** If the project has none: "no State yet: import your WORK-STATE.md".
  3. **Inbox**, unread messages first.
  4. **Open tasks**, in brief.
  5. **Who else is on this project now:** sessions seen in the last 30 minutes.
  6. **A copy check:** the State version, so the agent can compare it with its repo copy.
- **It registers the session as present** (see 5).

### 4. Messages (new collection `messages`)
- **Fields:**
  - `to`: a project, optionally narrowed to a session label (a hint for who should act, not a privacy line: every
    reader of the project can read it; the door can't express "this person only", so person-private messages are out);
  - `from`: the person, the agent (chat / claude-code / cloud / other AI), and the session label;
  - `kind`: decision, request, question, or fyi;
  - `body`: up to 4,000 characters;
  - `refs`: tasks, commits, files;
  - `thread`;
  - `status`: unread → seen → applied (with the commit) or rejected (with a note);
  - `senderCommit`;
  - `at`.
- **Tools:**
  - `send_message(project, kind, body, refs?)` answers with the target's presence ("cutroom: offline, last active
    3 h ago; it will get this on start");
  - `inbox(project?)`;
  - `message_status(id, status, note?, commit?)`;
  - `reply(id, body)`.
- **Trust, stored on the message as `word`, set by the server from how the call came in, never by the caller:**
  - **`person`:** written in the app (a signed-in browser session) or, from step 7, a Discord message from the
    linked account;
  - **`chat`:** sent through the claude.ai OAuth connector (`agent: 'claude'` in lib/caller.ts). That covers
    claude.ai, Desktop and the phone, but also anything unattended on the same connector (cloud sessions, scheduled
    runs), so it is not proof a person is present;
  - **`agent`:** a Claude Code key or any other key.
- **How the receiving agent treats it:**
  - a `person` or `chat` message from its own person is an instruction for ordinary work (code, notes, tasks); it
    never approves a ship step, production, money or credentials, and never answers a Need;
  - an `agent` message is a proposal: if its person is present, it asks them; if not, it notes the message and sticks
    to its task (in step 2 this becomes a Need);
  - a message from anyone else is information, labelled with their name.
- **Decisions:** applying a decision message adds it to the State's Decisions with `via` and the message id.
- **A request becomes a task** with one call, or one tap in the app.
- **In the app:** an Inbox tab on the project page lists threads and statuses, with Send, Apply/Reject for the person,
  and "Make a task".

### 5. Presence and the "for you" line
- **Presence:** a row `{ project, key, session?, label, machine, ai, lastSeen, forYouCursor }`, stamped with the
  project's placement. **Key of the row:** the session id when the call carries one, else the key id (or OAuth client
  id, which is per client per person) plus the project. `ai` is the client's name (`key.name` / the OAuth client
  name), so the roster says "Antigravity for Akash", not just "claude-code". Refreshed **at most once a minute** per
  row, and `presence` is kept out of the push-hint `TOPICS` (lib/scope.ts), so it causes no page refreshes.
- **The "for you" line:** each Work OS tool answer to a present session carries a short `forYou` field, for example
  "2 new messages on cutroom (inbox)". It carries **ids and counts only, never body text**. "Once per session" is one
  `forYouCursor` timestamp on the presence row: items newer than it are named, then the cursor moves. Slice 1 ships
  `forYou` as a **small registry of sources** (messages, answered Needs, new tasks, "State not saved since N writes"),
  so later slices add a source without editing the same lines. The wrapper is the one place every tool passes
  through (lib/mcp/server.ts, the `tool()` helper).
- **The save nudge:** when a session has made N writes (default 10) since its last `save_state`, `forYou` says
  "State not saved since 10 writes". The headline promise (close the laptop, lose nothing) can't rest on memory alone.
- **How a call says which session it is:** `start_work` returns a `session` id. The tools that matter for the
  "for you" line (start_work, save_state, the message and Need tools, get_task, log_progress, complete_task) take an
  optional `session` argument; the Orders tell agents to pass it. The header `X-Work-OS-Session` is read as well,
  for every agent kind, when a client sets it. The MCP endpoint stays stateless.

### 6. Hooks (Claude Code only; in batch 1, right after the tools work)
These are small, optional plugin hooks, shipped with batch 1 so the save doesn't depend on memory:
- **SessionStart** (also after compaction): calls `start_work` and puts the brief in context;
- **Stop:** if code changed this turn and the State wasn't saved, ask once.

Other AIs rely on the Orders and the "for you" line instead.

## What changes for Om
- **His global rule** "Keep WORK-STATE.md in the repo ... Update on start, stop, merge" becomes: "Keep the project
  State in Work OS: `start_work` on start, `save_state` on stop and merge. WORK-STATE.md is its copy, committed with
  the work." Om edits that line himself (Claude doesn't edit `~/.claude/CLAUDE.md`).
- **Each repo's CLAUDE.md** names its Work OS project in one line (C49), so `start_work` matches it at once.

## Tests (tests/e2e/flow-*.mjs, rows in run.sh's table)
| Flow | The test drives |
|---|---|
| S1 | Two keys (Claude Code, a second client) `start_work` the same project and get the same State version and Orders, and both show as present with their client names. An unknown remote returns candidates. |
| S2 | A stale `set_now` writes nothing and returns the current State; two appends from two sessions both land. The returned markdown carries the new version. `import_state` of a sample WORK-STATE.md fills Now, Next and Later. An MCP write to an Orders note is refused. |
| H1 | A chat key adds a note, a task and a Next line. The present session's next tool answer has `forYou` once (ids and counts only). A new session's `start_work` lists the item first. |
| MS1 | With nobody present, `send_message` answers "offline, last active …" and the next `start_work` lists the message. |
| MS2 | A present session gets `forYou` once per message. |
| MS3 | `message_status` applied, with a commit, shows to the sender. Applying a decision adds it to Decisions. (An `agent`-word message to an unattended session becoming a Need is slice 4.) |
| MS4 | A teammate's message reaches Om's session labelled as theirs, with `word` information. |
| Access | Leak-audit entries for every new tool and action: a member who can't see a private project can't read its State, inbox or presence, and can't send to it; a project made private takes its State and messages with it. |

S3 (Continue from the phone) is step 4 and has no test here.

## Build plan
- **Who builds:** builder B (features), in its worktree, on its own test database and ports.
- **Security review** before the merge (message trust and Orders are permissions).
- **Deploy**, then cutroom and Work OS move their WORK-STATE in (import), and run on it for a week.
- **Not in step 1:** Needs, results and the digest (step 2); the roster and machines (step 3); the Discord bot
  (step 7).

## Open questions for Om
1. **Orders, organisation layer:** turn the existing "Claude Code boilerplate" note into it, or start a fresh note?
   Recommendation: turn the boilerplate note into it; it's already what sessions read.
2. **Decisions in the app:** may anyone who can edit the project add one, or only the owner? Recommendation: anyone
   who can edit; each decision records who added it.
