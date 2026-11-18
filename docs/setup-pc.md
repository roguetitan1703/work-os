# Setting up a PC for Work OS and Claude Code

Everything a PC needs so every Claude Code session on it works with Work OS the same way (Om's PC, Akash's PC, a new
one). Written 18 Nov 2026; the design behind it is docs/flows/agent-system.md. Do the steps in order; each says how to
check it.

## 1. Programs
- Node 22 or newer, Claude Code (desktop app or CLI), Git. On Windows also Windows Terminal (wt.exe).
- Check: `node -v` prints v22 or higher; `claude --version` prints a version.

## 2. Connect Claude Code to Work OS (the MCP server)
```bash
claude mcp add --scope user --transport http work-os https://work.delpat.in/api/mcp
```
Then in Claude Code type `/mcp`, pick work-os, Authenticate, and press Allow on the Work OS screen.
- Use this one connection in Claude Code. The claude.ai "Work Os" connector reaches the same server; leave it off in
  Code sessions (each connection lists every tool again and costs tokens), keep it for claude.ai chat.
- Check: in a session, ask "call get_state for work-os"; it answers with the State.

## 3. The Work OS worker
In Work OS open Claude › Setup › Computers, type a name for this PC, press Add, and run the command it shows (it
downloads the worker, checks its checksum and runs `setup`; paste the device key when asked, it is never part of the
command). Details: worker/README.md.
- Check: Claude › Setup › Computers shows this PC as online.

## 4. The Work OS hooks (global, every folder)
From the worker folder (`%LOCALAPPDATA%\WorkOS\worker` on Windows, `~/.work-os/worker` on macOS; from the repo:
`worker/`):
```bash
node worker.mjs hooks install
```
It copies `hook.mjs` to the worker's config folder (`%APPDATA%\work-os-worker\hooks` on Windows) and adds four
entries to `~/.claude/settings.json`, keeping a dated backup and every other setting. It never touches
`~/.claude.json`. Run it again after a worker update; `hooks status` shows what is installed, `hooks remove` takes it
out.

| Event | What it does | Needs a key |
|---|---|---|
| SessionStart (start, resume, clear, compact) | Calls start_work for the folder and puts the Orders, State and tasks into the session | Yes |
| Stop | Files changed and State not saved: holds the session once and asks for save_state | Yes (uses the start record) |
| PreToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) | Refuses hand edits of WORK-STATE.md and says to use save_state | No |
| PostToolUse (save_state, import_state, get_state of any Work OS connection) | Writes WORK-STATE.md from the answer in the repo's main folder and commits that file alone (not in builder worktrees, not during a merge) | No |

All four fail open: no key, no network or an error means they print nothing and the session carries on.

## 5. The key for the start brief (until the hooks use the worker's key)
In Work OS: Claude › Setup › Claude Code key. Add it to the `env` block of `~/.claude/settings.json` yourself:
```json
"env": { "WORK_OS_KEY": "wos_..." }
```
Never paste the key into a chat, and never into `~/.claude.json`.
Without the browser (the owner on a PC that has the database credentials in `.env.local`): `node scripts/make-key.mjs --db <database> --email <you> --name "Hooks · <pc>" --apply` creates the key the way the app does and writes it into the settings file without showing it (Om's PC, 18 Nov: "Hooks · Victus-Knight"). (Planned: the hooks sign in with the worker's device
key, and this step goes away; agent-system.md section 4.)
- Check: start a new session in a repo that has a Work OS project; its first context says "Work OS brief for this
  project".

## 6. Global CLAUDE.md (`~/.claude/CLAUDE.md`)
A few lines only: call start_work and follow the Orders; status lives in Work OS State; WORK-STATE.md is a copy;
facts about this PC (RAM, disks, shells, limits). The rules themselves live in the Work OS Orders, so every PC gets
the same ones. The proposed text is in the side-session notes of 18 Nov (rules/global-CLAUDE.md), waiting on Om.

## 6b. Permissions in `~/.claude/settings.json` (global, every project)
Only rules that hold in every repo go here; a project's own test hosts, cloud projects and deploys are not global
(Om, 18 Nov: no per-project settings files; those steps ask).
- `permissions.allow`:
  - Work OS reads: `start_work get_state get_project get_task list_projects list_tasks list_notes read_note inbox
    needs recent_activity daily_summary message_status`.
  - Work OS writes of the agent's own work (the Orders: always theirs): `save_state import_state set_doing
    log_progress complete_task write_note add_task add_comment update_checklist ask withdraw_need hand_in slot`.
  - Each written as `mcp__work-os__<tool>`. Not allowed, so they still ask: deletes, `update_task`,
    `apply_changes`, `send_message`, every mail tool.
  - Test env files: `Read(**/.env.test.local)`, `Bash(grep * .env.test.local)`, `Bash(cut * .env.test.local)`,
    `Bash(cat .env.test.local)`.
- `permissions.deny`: `Edit(~/.claude.json)`.
- `autoMode.environment`: `$defaults` plus two lines. One says Work OS (work.delpat.in) is Om's own task system,
  where agents write their own status. The other says `.env.test.local` files hold test-only credentials for their
  repo's local and test hosts.
- Check: `node -e "console.log(Object.keys(require(require('os').homedir()+'/.claude/settings.json').permissions))"`
  prints `allow` and `deny`.

## 7. Check the whole setup
In a repo with a Work OS project:
1. A new session starts with the Work OS brief (step 5 done).
2. Ask it to append a line to WORK-STATE.md: refused, naming save_state.
3. Ask it to save State with any small change: WORK-STATE.md updates and a commit "WORK-STATE.md: copy of the Work
   OS State vN" appears.

## Not covered yet
- Cloud Claude Code sessions: one line per repo in `.claude/settings.json` plus a project key in the cloud
  environment (agent-system.md section 11).
- The Work OS plugin (one install for hooks, presence and messages) replaces step 4 when it ships.
