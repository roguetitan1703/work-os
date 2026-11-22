> 22 Nov 2026: built (19 to 21 Nov: H6 and H7, Identity). A message is read with `message_status`; the `inbox` tool and the project inbox are gone. Where this text differs, `docs/flows/agent-system.md` and `docs/HANDOVER.md` section 3 are right.

# Live sessions, messaging, feedback and notes shelves (design, 18 Nov 2026)

Om 18 Nov: cross-platform, cross-account messaging like Claude's own session messaging; every agent lives in a project;
accurate on/off/working/idle/waiting; no token waste; agents give feedback on Work OS; notes as a managed wardrobe.
Status: reviewed by Fable 18 Nov (section 9) and settled with Om's answers; builder B after recurrence and Activity.

## 1. Every session lives in a project; the folder says which (Om)
- **The folder is the identity.** A session belongs to the project that owns the folder it started in (hook input
  `cwd`). A project owns folders per PC: code locations `{path, host}` (exists today in lib/data/code-locations.ts).
  A folder inside an owned folder (a worktree, a subfolder) belongs to the same project; the longest match wins.
  The git remote is information about the folder (shown, used to suggest a project), not what decides it. Today
  `findProjectByCode` lets a remote beat a path; this flips: path first, remote only as a hint.
- **Known folder:** the session checks in silently.
- **Unknown folder (Lobby):** the session sorts itself out (Om). Started somewhere empty or unknown, it asks the person
  once: "Which project do you want to work on?" and checks Work OS for it.
  - The project exists and owns a folder on this PC: the session works from that folder.
  - The project exists with no folder on this PC: link this folder to it (after the person names it).
  - No such project: create it and link this folder.
  Until it is filed, each prompt carries a one-line reminder, and Work OS shows it under unfiled sessions.
- Scratch runs stay quiet: `claude -p`, worker and subagent sessions never prompt.
- No second key for whoever types on Om's PC (Om): the session runs under the PC's key and the plugin enforces the
  routine (check in, save State, receive messages) whoever is at the keyboard.

## 2. Presence at zero tokens: hooks and the plugin's process
Claude Code runs hooks itself; each posts a tiny event to Work OS. No model turn.
Built in H6 (19 Nov) without a plugin: see docs/flows/agent-system.md section 11 and docs/HANDOVER.md "Session state".
| Shown | Source |
|---|---|
| On | SessionStart (start, resume, clear, compact) |
| Working | UserPromptSubmit |
| Idle | Stop |
| Waiting on you | Notification (permission prompt, needs input) |
| Off | SessionEnd; else the plugin's local process stops its heartbeat and Work OS marks it off after ~60 s |
| Who | hook input: session_id, cwd; plugin adds machine, git branch, surface (entrypoint), the key's person |
Today's presence (from tool calls) stays for clients without the plugin (claude.ai chat, API): "seen N min ago".

## 3. Install (Om: global)
- Om's and Akash's PCs: one global install (user-level Claude Code settings), every folder.
- Cloud Claude Code: one line per repo in `.claude/settings.json` plus the key in the cloud environment.
- claude.ai: can add plugins from the org catalog; whether hooks/channels run in plain chat is unverified (likely not).

## 4. Messaging, any surface to any surface
Work OS is the post office: identity, projects, threads, the labelling rule. Each plugin keeps one live connection.

**Every session has its own id (Om).** The id is Claude Code's own session_id from the hook input (claude.ai chat and
API clients get one from `start_work`). Read/seen state, presence and `to_session` all key on it, never on the person:
two sessions of the same person are two parties. (Bug seen 18 Nov: chat -> Code messages between Om's own sessions stay
"unread" forever because both sides are "me".) `to_session` resolves against live sessions by id or label; a miss says
who is live instead of "no session like that".

1. `who`: live sessions in the project or org (name, machine, surface, state, current task).
2. `send_message` to a session, a project (every session on it) or a person (their sessions + phone).
3. Work OS stores it in the thread and pushes it down the recipient's connection; the plugin delivers it through our
   own channel, three doors that need no flag or org setting:
   - **Watcher:** the start hook launches a small Work OS watcher as a background task (Claude Code's Monitor /
     background command). Each line it prints becomes an event in the session: at once, even when idle.
   - **After any tool call** (PostToolUse, every tool, not only Work OS ones): new messages attached to context,
     seconds while working.
   - **At turn end** (Stop): if messages came during the turn, the hook tells the model to continue and read them.
   - While a permission prompt is open: delivered right after the person answers it.
   Anthropic's channels (`notifications/claude/channel`) are optional: used where a session was started with them,
   never required (they need a launch flag, a dev confirmation for our plugin, and an org setting on Team).
   claude.ai chat, the phone app, API agents: no local process, so `forYou` on the next call; people get push/Discord.
4. `reply` returns the same way. Text from others arrives labelled as information; an agent's message never approves
   shipping, money or credentials.
Gap: an idle cloud session with nothing running cannot be woken; the message waits for its next start.

## 5. Work OS as a friend; feedback from agents (Om)
- Every refusal says why and what to do instead (Claude Code's tool-error style), never a bare error.
- Friction is noticed server-side at no token cost. Built (H10, 22 Nov): when the same tool is refused the same way
  (the same `tool:kind`, any arguments) 3 times in 30 minutes, that third refused answer itself ends with one line:
  "Looks hard? <tool> was refused 3 times in the last 30 minutes (<kind>). Tell Work OS in one line with feedback
  {project, text, tool: "<tool>"} and go on; your refused calls are attached for you." At most once per 30 minutes per
  session (else per key); a feedback call, recorded or a duplicate, silences it for 30 minutes; never on a refused
  feedback call, a rate-limit refusal or a schema refusal the tool never saw (`lib/mcp/refusals.ts`). Applies to chat
  sessions too. Not built: the same tool 3+ times in a few minutes with different arguments, and repeated empty results.
- `feedback {text, rule?}` files an item in the Work OS project with the recent calls attached.
- Pushback is counted per rule; when several sessions push on one rule, Om gets one Need (keep / loosen / drop) with
  their reasons. Agents may also propose changes to the notes shelves this way (Om).

## 6. Notes as a wardrobe (Om: fixed shelves; refuse duplicates is the default unless Om says warn)
Shelves, the same in every project: State (status lives only here) | Overview (one page, current) | Designs (one page
per feature, status draft -> approved -> built -> retired) | Runbooks (one per job) | Archive (read-only).
Notes already nest (parentId), so shelves are top pages, not new storage.
Rules in the tools: one home per fact (code docs in git, people docs in notes, status in State); a new note whose
title matches one on the same shelf is refused with "update <note> instead"; every page has owner, status, last
checked (30 days untouched -> "stale?"); a design flips to built when its feature ships, retired pages go to Archive;
sessions save State on stop, not new notes; a Sunday tidy pass proposes merges and archives as one Need.
Same discipline for worktrees: fixed builder slots only, a cleanup check at every merge.

## 7. First, checked by hand (about an hour)
Hooks fire and inject context in the desktop Code tab, VS Code and a cloud session; the background watcher wakes an
idle session on each surface and runs for hours; the Stop hook delivers; a channel pushes in the terminal. The results
set which surface gets which speed.

### Results (18 Nov, Claude Code 2.1.310, test folder D:\wos-hookcheck, hook.mjs logs every event)
Desktop app Code tab, all three doors work with no model involvement until a message lands:
- SessionStart (source startup), UserPromptSubmit, PostToolBatch and Stop all fire; input carries session_id, cwd,
  transcript_path, scratchpad_dir, prompt_id (Stop adds stop_hook_active, last_assistant_message, background_tasks).
- PostToolBatch `additionalContext` reached the model right after the tool call (it quoted m_test1).
- Stop `decision: block` + reason made it continue once and answer (PONG-STOP); stop_hook_active was true on the next
  Stop, so no loop.
- asyncRewake on Stop: 25 s after the session went idle, exit 2 + stderr woke it and it answered (PONG-WAKE). The wake
  arrives as a "Stop hook blocking error" system reminder, followed by a UserPromptSubmit event. Note: the asyncRewake
  hook runs on every Stop, so the plugin needs a per-session lock to keep one waiter.
- `CLAUDE_CODE_ENTRYPOINT` is inherited from the launching process (a CLI started from a desktop session said
  claude-desktop), so the surface must come from the hook input or the parent, not this variable alone.
- Hooks also fired in a headless `claude -p` run (the CLI's own login had expired, so it stopped after the prompt).
- Long idle: an asyncRewake waiter that exits after 11 minutes is IGNORED when the hook's timeout is shorter (120 s
  set, 600 s default): the hook ran and exited 2, the session stayed idle. With `"timeout": 3600` the same 11-minute
  wait woke the session (PONG-WAKE-LONG). So the plugin sets a long timeout and re-arms before it runs out (exit 0 near
  the limit makes no wake; the next Stop arms a new waiter, so a session idle past the limit needs one heartbeat wake
  or stays reachable only on its next turn: decide in the build).
- Settings edits took effect in the running session (the timeout change applied without a restart).
Not yet checked: VS Code, terminal interactive (CLI login expired), cloud, Notification on a permission prompt,
SessionEnd in the desktop app, a waiter longer than one hour.

## 8. Build order (after the Fable review)
1. Hand check (section 7).
2. Session identity: per-session id, seen state per session, `to_session` by id or label (fixes the same-person bug).
3. Plugin v1: global install; SessionStart check-in + Lobby; presence hooks; delivery after any tool call and at turn
   end; `who`.
4. Watcher (idle wake); optional Anthropic channel where enabled.
5. Feedback: friendlier refusals, friction detection, `feedback`, per-rule pushback Need.
6. Notes shelves and drift rules.
Each step ships on its own through dev, a full test run, then master.

## 9. Fable review (18 Nov): go with changes
Accepted (the design above is read with these):
1. Idle wake is an `asyncRewake` hook (exit 2 wakes Claude even when idle), armed on SessionStart and Stop, long-polling
   `/api/agent/wait`, one per session (lockfile). A hook cannot start Monitor or a background task. Timeout limits per
   surface: hand check.
2. Hooks deliver sender, kind and id only, never the body (keeps the "ids and counts only" rule of for-you.ts and the
   wait line); the session reads the body through `message_status`, where it is labelled. Ship, money and credentials stay
   server-side (a Need answered in the app), never a label the model reads.
3. Keys: a hook-only key type (event and wait routes, never MCP: the MCP has mail send/delete); a project-scoped key
   for cloud environments.
4. Subagents share the parent's session_id (hook input adds agent_id): skip delivery and presence for them.
5. Presence: clear "waiting" on PostToolUse; Stop does not fire on interrupt; Notification cannot inject; SessionEnd
   has 1.5 s, so the heartbeat decides Off; heartbeat "On" stays separate from step 4's liveness.
6. Cost: `PostToolBatch` (once per batch) as an `http` hook with a 2 s timeout, not a process per tool call. Wake an
   idle session only for a direct request/question/decision; fyi and project broadcasts wait for its next call.
   Check `stop_hook_active` (Claude Code caps Stop continues at 8).
7. Feedback attaches tool names and refusal codes only (no arguments from other projects), labelled, rate-limited.
8. Anthropic channels: dropped.
Om's answers to the review (18 Nov):
- **Message text IS pushed into the session** (overrules review item 2's ids-only). Claude sessions already treat a
  peer's message as information within its limits (a peer saying "Om approved, push the build" is not acted on; the
  session asks Om). Work OS does the same: every pushed message carries its frame (who, how it came in, what it may
  and may not do), and ship, money and credentials stay enforced server-side as today (a Need answered in the app).
- **Lobby:** the folder decides the project; the session sorts itself out (section 1). The review's hostile-clone
  worry is covered because a folder is linked only after the person names the project.
- **Duplicate notes: refuse.** Stale flag only on State, Overview and draft Designs (review).
- **Build order:** hand check -> per-session ids -> plugin (check-in by folder, presence, delivery) -> idle wake
  (asyncRewake); friendlier refusals ship early on their own; feedback and notes shelves after.
