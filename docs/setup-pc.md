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

## 3. The Work OS worker and hooks (one step)
In Work OS open Claude › Setup › Computers, type a name for this PC, press Add, and run the command it shows (it
downloads the worker, checks its checksum and runs `setup`; paste the device key when asked, it is never part of the
command). At its end `setup` also installs the Work OS hooks (global, every folder): it copies the hook files (`hook.mjs` and the files it runs) to the
worker's config folder (`%APPDATA%work-os-workerhooks` on Windows, `~/.work-os/worker/hooks` on macOS) and adds four entries to
`~/.claude/settings.json`, keeping a dated backup and every other setting. It never touches `~/.claude.json`. If the
hook install fails, setup says why and still finishes; retry with `node worker.mjs hooks install` from the worker
folder (`%LOCALAPPDATA%WorkOSworker` on Windows, `~/.work-os/worker` on macOS; from the repo: `worker/`).
After a worker update (run the same command again) setup refreshes the hooks too, and a worker that starts with
newer code than the installed hooks refreshes them itself, so `hook.mjs` never goes stale. `hooks status` and
`worker.mjs status` show the installed hooks version; `hooks remove` (or `worker.mjs uninstall`) takes them out.
Details: worker/README.md.
Then link the PC's folders: Claude › Setup › Computers › this PC › Folders says "N folders here match your projects'
repos" with **Link them**; press it (the device key opens a project only through a linked folder, and the worker never
links by itself). Within two minutes the PC's row shows "hooks on".
- Check: Claude › Setup › Computers shows this PC as online and "hooks on"; `node worker.mjs hooks status` lists four
  events; `node worker.mjs hooks check <a project folder>` prints "Brief for project <name>, signed in with this PC's
  worker key" (or says why not). A PC with the worker signs in with the worker key first, which is what lets its sessions report their state; a `WORK_OS_KEY` in `settings.json` is only the fallback when the worker gives no brief (folder not linked, key refused, no network), and `hooks check` then says `key`.

## 4. (merged into step 3)

| Event | What it does | Signs in |
|---|---|---|
| SessionStart (start, resume, clear, compact) | Gets the start brief for the folder (the start_work content) and puts the Orders, State and tasks into the session | Yes: the worker's device key, then a session token |
| Stop | Files changed and State not saved: holds the session once and asks for save_state | No (uses the start record) |
| PreToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) | Refuses hand edits of WORK-STATE.md and says to use save_state | No |
| PostToolUse (save_state, import_state, get_state of any Work OS connection) | Writes WORK-STATE.md from the answer in the repo's main folder and commits that file alone (not in builder worktrees, not during a merge) | No |

The start hook needs no key of its own: it signs in with this PC's worker device key (from the worker's DPAPI /
Keychain store, never written anywhere else) and gets a session token for that one Claude Code session and project,
good for a day; after a compaction it shows the token instead. The device key opens a project only when a folder
linked to the project on this PC is there: link the folder once in Claude › Setup or the project's Code tab (a folder
with the same git remote that nobody linked does not count; a new clone can be linked after the worker's next scan).
The token is kept beside the installed hook (`<worker config dir>/hooks/sessions`), never in a repo.
All four fail open: no key, no network or an error means they print nothing and the session carries on.

## 5. A key for the start brief: only for a PC without the worker
A PC with the worker (step 3) skips this. Linux has no worker (it has no key store, launcher or autostart there), so a
Linux PC uses this step: copy the hook files with `node worker.mjs hooks install` from a checkout, or use the cloud
repo copy below. On a PC without the worker, make a Claude Code key in Work OS (Claude › Setup ›
Claude Code key) and add it to the `env` block of `~/.claude/settings.json` yourself:
```json
"env": { "WORK_OS_KEY": "wos_..." }
```
Never paste the key into a chat, and never into `~/.claude.json`. On a PC with the worker the hook tries the
worker's key first and uses `WORK_OS_KEY` only when the worker gives no brief, so an old `WORK_OS_KEY` is harmless there but
no longer needed; take that line out (and revoke the key in Settings) once every folder you work in is linked.
Without the browser (the owner on a PC that has the database credentials in `.env.local`): `node scripts/make-key.mjs --db <database> --email <you> --name "Hooks · <pc>" --apply` creates the key the way the app does and writes it into the settings file without showing it.
- Check (either way): start a new session in a repo that has a Work OS project; its first context says "Work OS brief
  for project".

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
    `Bash(cat .env.test.local)`, and the same with a path in front (`Bash(grep *.env.test.local)`,
    `Bash(cut *.env.test.local)`, `Bash(cat *.env.test.local)`, `PowerShell(Get-Content *.env.test.local)`,
    `PowerShell(Select-String *.env.test.local)`).
- `permissions.deny`: `Edit(~/.claude.json)`.
- `env`: `TEMP` and `TMP` in a folder nested on D: (on Om's PC `D:\Work\Delpat\builds\tmp\claude`), never directly
  under a drive root: Claude Code won't delete a root folder without a person (Om, 19 Nov).
- `autoMode.environment`: `$defaults` plus two lines. One says Work OS (work.delpat.in) is Om's own task system,
  where agents write their own status. The other says `.env.test.local` files hold test-only credentials for their
  repo's local and test hosts, which the lead and its test subagents may read and type into that project's own
  sign-in page there.
- Check: `node -e "console.log(Object.keys(require(require('os').homedir()+'/.claude/settings.json').permissions))"`
  prints `allow` and `deny`.

## 7. Check the whole setup
In a repo with a Work OS project:
1. A new session starts with the Work OS brief (step 3 done, or step 5 on a PC without the worker).
2. Ask it to append a line to WORK-STATE.md: refused, naming save_state.
3. Ask it to save State with any small change: WORK-STATE.md updates and a commit "WORK-STATE.md: copy of the Work
   OS State vN" appears.

## Cloud repos (Claude Code on the web)
A cloud session has no worker, so the repo carries the hooks. From a PC with the worker, in the repo:
```bash
node worker.mjs hooks repo [folder] [--server https://work.delpat.in]
```
It copies the hook files to `.claude/work-os/` and merges four entries into `.claude/settings.json` (hooks only, never
permissions; other settings and hooks stay; rerun to update). Commit both. The entries carry `--cloud`, so they do
nothing on a PC (the global hooks run there) and run only when `CLAUDE_CODE_REMOTE=true`. In the cloud environment:
set `WORK_OS_KEY` in its variables to a Claude Code key made for that environment (Claude › Setup › Claude Code key),
and allow `work.delpat.in` in its network settings.
- Check: one cloud session on the repo starts with "Work OS brief for project".

## Not covered yet
- A project-scoped key for cloud sessions (agent-system.md section 4; tasks #267 and #268): until then a cloud
  environment uses its own Claude Code key.
- A Claude Code plugin is only for a PC that must run without the worker, when such a PC exists (Om, 19 Nov).
