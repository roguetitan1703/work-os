# Live sessions, messaging, feedback and notes shelves (design, 18 Nov 2026)

Om 18 Nov: cross-platform, cross-account messaging like Claude's own session messaging; every agent lives in a project;
accurate on/off/working/idle/waiting; no token waste; agents give feedback on Work OS; notes as a managed wardrobe.
Status: draft, waits on a Fable review, then builder B. Om's answers so far are marked (Om).

## 1. Every session lives in a project (Om: yes, Lobby for strays)
- At every session start a hook asks Work OS which project the folder belongs to (the repo's CLAUDE.md line, then the
  project's code locations). Known: the session checks in silently. Unknown: it sits in the **Lobby** (shown in Work OS
  as unfiled sessions) and the hook gives the model one instruction before anything else: ask which project this is,
  create it if it doesn't exist, link this folder. Until then each prompt carries a one-line reminder.
- No second key for whoever types on Om's PC (Om): the session runs under the PC's key and the plugin enforces the
  routine (check in, save State, receive messages) whoever is at the keyboard.

## 2. Presence at zero tokens: hooks and the plugin's process
Claude Code runs hooks itself; each posts a tiny event to Work OS. No model turn.
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
- Friction is detected server-side at no token cost: the same tool 3+ times in a few minutes with different arguments,
  repeated empty results, the same refusal twice. The next answer carries one line: "Looks hard? Tell Work OS with
  `feedback` (one line)." Applies to chat sessions too.
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

## 8. Build order (after the Fable review)
1. Hand check (section 7).
2. Session identity: per-session id, seen state per session, `to_session` by id or label (fixes the same-person bug).
3. Plugin v1: global install; SessionStart check-in + Lobby; presence hooks; delivery after any tool call and at turn
   end; `who`.
4. Watcher (idle wake); optional Anthropic channel where enabled.
5. Feedback: friendlier refusals, friction detection, `feedback`, per-rule pushback Need.
6. Notes shelves and drift rules.
Each step ships on its own through dev, a full test run, then master.
