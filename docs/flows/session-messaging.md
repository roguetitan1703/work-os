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
1. `who`: live sessions in the project or org (name, machine, surface, state, current task).
2. `send_message` to a session, a project (every session on it) or a person (their sessions + phone).
3. Work OS stores it in the thread and pushes it down the recipient's connection; the plugin delivers it:
   channel (`notifications/claude/channel`, at once, terminal; dev flag until allowlisted; org setting on Team) ->
   else a PostToolUse hook attaches it after the current tool call (seconds while working) ->
   else, idle, the wait line (step-4.md section 6) wakes the session. claude.ai chat and API: `forYou` on the next call.
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
Hooks fire and inject context in the desktop Code tab, VS Code and a cloud session; a channel pushes in the terminal;
a background wait runs in a cloud session. The results set which surface gets which speed.
