# Session launcher: contract between Work OS and the worker

Start, resume and stop Claude Code sessions on Om's machines from Work OS. Conversations go
through Claude's Remote Control (the Claude app), never through Work OS. Work OS is the control
panel; the worker is a small Node program on each machine.

## Rules (both sides)

1. Paths never leave the machine. Work OS knows folders by `folderId` + display `name` only. One exception, by design (turbo mode below): the worker reports its projects folder (`projectsDir`) so the page can say where a clone will go.
2. The worker does exactly these things: start, resume, stop, open a session in VS Code, and reopen/dismiss the sessions
   it remembers were open before a restart ("VS Code and Reopen after a restart" below). It never runs commands from the
   server and launches `claude` and VS Code with argument arrays (no shell string, except the macOS
   Terminal script, which must quote every value).
3. A job's optional `prompt` is only ever text Om typed at Start. Work OS never fills it from a
   task, note, Discord or Claude.
4. Normal permission mode. Never `--dangerously-skip-permissions`, never `--bare`.
5. Status only: session id, folder, state; plus, for the Claude page, folder names and session titles (see "Activity counts", Om's decision 2026-10-15). No transcript text, logs, code or full paths.
6. Outbound only. One device key per machine (`wkr_…`), revocable on Claude › Setup › Computers (`/claude?tab=setup`; `/connect?tab=devices` redirects there).
7. Kill switch: `enabled: false` in the worker config, or revoke the key.

## Installing without the repo

Teammates do not have the repository. Work OS serves the worker as one file: `GET /worker/work-os-worker.mjs` (a loader with `worker/*.mjs`, tests excluded, embedded; built by `worker/bundle/build.mjs` from the release's own files, so a release's bytes and sha256 never change; `ETag` is the sha256) and `GET /worker/latest.json` (`{ version, sha256, bytes }`). Both are public (no cookie, no key; the install command needs them before a key exists) and carry no secrets: only the worker's source. Claude › Setup › Computers shows, after Add, one copy-paste command per OS (`lib/worker-install.ts`): download to `%LOCALAPPDATA%\WorkOS` or `~/.work-os`, verify the sha256 shown (PowerShell `Get-FileHash`; macOS a Node one-liner; this is a download-integrity check only: the file and the hash come from the same origin, so it proves nothing about who published them, and anyone who controls the server controls both), run `setup --server <APP_URL>`. The device key is typed at setup's hidden prompt, never in the command. Run, the file unpacks into a `worker/` folder beside itself, writes `worker/BUNDLE` (its sha256) and runs `worker.mjs` there with the same arguments (it refuses Node older than 22). The worker reports `worker.bundle` (12 hex of the sha256) in its status; the Computers list shows "update available" when it differs from the served one, and the worker logs the same (`update.mjs`, every 6 hours). Updating = run the command again; the supervisor restarts the worker when the unpacked code changes. No self-update, on purpose (server-delivered code would be remote code execution on every teammate's computer).

Setup also checks the server address: a stored `*.vercel.app` address, or HTTP 402 or 404 on the key check, is named plainly and the current address offered; the default is `https://work.delpat.in`.

**Autostart** (`worker/install.mjs`) needs no administrator: on Windows a per-user `HKCU\...\Run` value runs the supervisor hidden at logon (and now), replacing the old ONLOGON scheduled task, which needed admin and is deleted if present; on macOS a LaunchAgent. A failure to set it is one line in setup's output with the hand command, not an error. One supervisor per config folder (`supervisor.pid`, refreshed every few seconds so a leftover file after a reboot is ignored).

**Replace key** (Computers list, per computer; needs a recent sign-in like Add): a new `wkr_` key for the same computer. Its id, folder links, sessions and queued jobs stay; the old key stops working at once (the stored hash is replaced) and its open stream is closed; only the person who owns the computer can do it (`replaceDeviceKey`, lib/devices.ts); the document records `keyReplacedAt` and `keyReplacements`. The new key is shown once with the same install instructions.

## Auth

`Authorization: Bearer wkr_<43 base64url chars>` on every request. Device keys are a separate
kind from Claude Code keys (`wos_…`): they open `/api/worker/*` and nothing else, and `wos_` keys
are refused there.

All bodies are JSON. Errors: `{ "error": "…" }` with 400 / 401 / 413 / 429.

## Endpoints

### POST /api/worker/folders: report a scan (replaces this device's folder list)

```json
{
  "folders": [
    { "id": "f_3k9…", "name": "pms", "git": true, "remote": "github.com/roguetitan1703/pms", "branch": "master" },
    { "id": "f_8a1…", "name": "AKAR-wt/debt-3", "git": true, "remote": "github.com/roguetitan1703/akar", "branch": "wt/debt-3" },
    { "id": "f_x2q…", "name": "Rcrm", "git": false }
  ]
}
```

- `id`: chosen by the worker, stable per folder (kept in its local state; reused from a marker's
  `folderId` when one exists). `[A-Za-z0-9_-]{4,40}`.
- `name`: a label Om recognises, relative to the allowed root, `/`-separated, ≤ 120 chars. Not an
  absolute path.
- `remote`: credentials stripped, lowercase `owner/name` without host or `.git` (same form as project code locations), ≤ 200. Omit when none.
- `branch`: ≤ 120. Omit for non-git folders.
- At most 3000 folders. Folders not in the latest scan are marked missing (never deleted).
- Which folders: git repos, folders with a project file, and every parent folder between a root and those (so a client folder holding several repos can be linked). Paths never leave the machine; only the name relative to the root is sent.

Response: `{ "ok": true, "known": 112, "missing": 1 }`



```json
{
  "enabled": true,
  "pollSeconds": 30,
  "links": [{ "folderId": "f_3k9…", "projectId": "pms", "projectName": "PMS" }],
  "jobs": [
    { "id": "j_1", "kind": "start", "folderId": "f_3k9…", "projectId": "pms", "projectName": "PMS", "sessionId": "8c1d…uuid", "prompt": "optional, typed by Om" },
    { "id": "j_2", "kind": "resume", "folderId": "f_3k9…", "sessionId": "8c1d…uuid" },
    { "id": "j_3", "kind": "stop", "sessionId": "8c1d…uuid" }
  ]
}
```

- `links`: every folder on this device linked to a project. The worker makes sure each has a
  marker (below) and removes markers it wrote for folders no longer linked.
- `jobs`: pending jobs for this device, oldest first. Handed out once (marked taken); a job not
  reported within 10 minutes is offered again.
- `sessionId`: chosen by Work OS (UUID v4) for start, so the session is known before it runs.

### POST /api/worker/status: results and live sessions

```json
{
  "worker": { "version": "0.1.0", "os": "win32" },
  "jobs": [{ "id": "j_1", "ok": true }, { "id": "j_3", "ok": false, "error": "session not running" }],
  "sessions": [{ "sessionId": "8c1d…uuid", "folderId": "f_3k9…", "state": "running" }]
}
```

- `sessions`: every session this worker started or resumed that it still tracks. `state`:
  `running` | `dead` (process gone, not stopped by a job) | `stopped`. Send at least once a minute
  (it doubles as the heartbeat).
- `error` ≤ 300 chars.

Response: `{ "ok": true }`

### GET /api/worker/stream: push (phase 5)

A Server-Sent Events stream with the same device-key check as the routes above (`worker/push.mjs`). Events:
`hello` on open, `jobs` when there is something to fetch (a start, resume or stop job for this computer, a folder
linked or unlinked, a task given to Claude, the dispatcher turned on, a claim that ended), `bye` when the server
closes it (`ttl` after 30 minutes: reconnect at once; `closed`: the owner was removed or the computer revoked). No job
data travels on it: on `jobs` the worker polls `GET /api/worker/jobs` at once. While it is up the worker polls only
every 5 minutes, and sends status every 2 minutes only while a session it started runs or job results wait; otherwise
only when what it reports changed (at least every 30 minutes). The server treats a connected computer as online and
its last report as current. Details: docs/multi-user.md "As built: phase 5 push".

## Activity counts

How many Claude Code sessions and subagents are running on each computer, and which ones (named), for Claude › Now. Read-only: the worker controls nothing from this. The counts are numbers only; the session list also carries folder names and session titles (see "Named session list").

- Sent as `activity` in every status report (about every 55 s):
  `"activity": { "sessions": 5, "sessionsWorkOs": 1, "sessionsOther": 4, "sessionsActive": 4, "subagents": 3, "at": 1792054228304 }`
  Whole numbers only; the server rejects anything else (400) and caps values at 999. It stores the latest per device and stamps its own receive time (the worker's `at` is ignored).
- Sessions: `claude` / `claude.exe` processes on the machine, not only Work OS ones (VS Code extension, terminal). One per session: `claude mcp`, `update`, `--version` style helpers are skipped, a claude process whose parent is another claude process is that session's child, and a repeated `--session-id`/`--resume` id counts once. `sessionsWorkOs` = those matching a session this worker started; the rest are `sessionsOther`. Process command lines are looked at on the machine and never sent.
- Subagents: files `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl` modified in the last 2 minutes. **mtimes only**: transcript files are never opened or read, and no path or name is sent. `sessionsActive` = top-level `<project>/<session>.jsonl` modified in the last 2 minutes (a cross-check of `sessions`). A `subagents` folder untouched for a day is skipped; at most 20000 stats per cycle. Root override for tests: env `WORK_OS_CLAUDE_PROJECTS`.
- A subagent counts as "working" while its file was written in the last 2 minutes, so a subagent that is thinking silently for longer drops out, and one that just finished stays for up to 2 minutes.
- Om's side: `claudeOverview().activity` gives each computer and a total over the computers that reported within 3 minutes; a computer silent longer shows "No news from <computer>" instead of old numbers.
- Try it without sending anything: `node worker/worker.mjs activity`.

### Named session list

Om's decision, 2026-10-15 ("Yes, send names"): for ALL Claude Code sessions on a computer (VS Code, terminal, Work OS-started) the worker also sends a list so the Claude page can show what is running. Sent as `claudeSessions` in every status report, next to `activity`:

```json
"claudeSessions": [
  { "sessionId": "8c1d…uuid", "folder": "pms", "title": "Fix the invoice export", "lastActiveAt": 1792054228304, "subagentsActive": 2, "startedByWorkOs": false, "running": true }
]
```

- **Only these seven fields.** `folder` is the folder NAME (last path segment of the session's cwd), never a path. `title` is at most 80 characters. No message text, no full paths, no file contents.
- **Which sessions:** a session with a running `claude` process, or a transcript modified in the last 10 minutes; newest first, at most 50. A process whose arguments carry `--session-id`/`--resume` is tied to that session. A process with no id (plain terminal, VS Code) cannot be tied by id, so each one is matched to the most recently written transcript not already claimed (within a day): best effort, so `running` for those can be wrong when several are open.
- **Title:** read from the title records Claude Code writes into `~/.claude/projects/<proj>/<sessionId>.jsonl`: `custom-title` (`customTitle`, a name Om gave) beats `ai-title` (`aiTitle`, generated), then `agent-name`, then `summary`; the last record of the best kind wins. Only lines of those types are parsed (the last 512 KB of the file, then the first 128 KB if nothing was found); other lines are skipped without parsing, and `cwd` is cut down to its last segment immediately. No title: the `--name` argument of the process, else the folder name.
- `subagentsActive`: subagent files of that session modified in the last 2 minutes (mtimes only). `startedByWorkOs`: the session id is one this worker started. `running`: process alive.
- **Server:** `cleanClaudeSessions` (lib/data/launcher.ts) validates strictly and answers 400 for a non-array, more than 50 entries, a bad or repeated UUID, a folder over 80 chars or that looks like a path (separators, drive letter, `~`, `..`), a title over 500 chars (80 to 500 is trimmed to 80), a bad time, count or flag. Nothing is written when any entry is bad. The latest list per computer replaces the previous one (`devices.claudeSessions`); a list older than 6 hours is ignored.
- **Om's side:** `claudeOverview().sessions` merges the list with the Work OS session records. Stop, Resume and Remove appear only on sessions Work OS started; the others are read-only. States: working (written in the last 2 minutes or subagents working), open, idle (open but quiet 15 minutes), closed, plus starting / stopped / failed / no news from the Work OS records.
- Try it without sending anything: `node worker/worker.mjs activity` prints the counts and a summary; add `--titles` to print the list on your own console.

## Claude area and Start flow (Om's side)

- `/claude` (tabs Now, Queue, Setup via `?tab=`): Now has a summary line, a compact Needs you list (3 shown, tap to reply) and the named Sessions list grouped by computer (`lib/data/claude-overview.ts`), with Stop behind a confirm and Remove with Undo.
- Start Claude is one component (`components/start-claude.tsx`, mounted in the app layout): `?start=1` picks a project, `?start=<projectId>` opens the confirm modal (computer, folder, first message). With no linked folder it offers "Link and start" for a same-repo suggestion, or a folder search that links and starts.

## Turbo mode (clone, link, start)

Start Claude on a project (or give a task to Claude) and, if the project's repo is not on that PC yet, the PC's worker makes the folder, clones the repo, links the folder to the project, trusts it and starts Claude there. If the repo is already there (a linked folder, or a scanned folder whose git remote matches the project's code remote) it starts straight away (a matching unlinked folder is linked first). Om's rule: security must not hinder the work. Anyone who can start a session on a PC can already have Claude clone anything, so this is on by default and asks nothing.

- **Where the repo comes from:** the project's first code location with a remote (Project › Info › Code). `owner/name` means GitHub (`https://github.com/owner/name.git`); a location written as a full URL keeps its host (`host` field, stored beside the lowercase `owner/name`; `https://host/owner/name` is sent), so any host works over https. A project with no repo keeps today's behaviour (pick a folder) and the sheet says "Add the repo in Info › Code to let your PC clone it". Limits: a nested GitLab group path is cut to the last two parts; ssh-only hosts are cloned over https.
- **Job:** a `start` job with `clone: { repo }` and no `folderId`. The session row is created at once as `starting` with `cloning: true`, `folderId: ''` and `repo`. Only for a computer of the person who started it (`lib/data/turbo.ts`, same device scope as Start; a teammate gets "not found", and their own Start sheet only lists their own computers). The computer must report `allowClone: true` and a `projectsDir` (status `worker` block; an older worker reports neither and is refused with "update the worker").
- **Worker (`worker/clone.mjs`):** destination `<projectsDir>/<safe repo name>`; if it exists and is the same repo (git remote compared) it is reused, if it is something else the next is `<name>-2`, `-3`…; it must stay inside `projectsDir` (plain name characters, no reserved Windows names, symlinks skipped), `projectsDir` must be inside a scan root, and a scan root's own path is never the destination. `projectsDir` defaults to the first scan root (config `projectsDir`, setup `--projects DIR`). The only hard guards: git runs as `git -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always -c protocol.git.allow=never clone -- <url> <dest>` with an args array and no shell; addresses that run commands (`ext::`, `fd::`, any `helper::`), `file:`, `git:`, `http:`, local paths and anything starting with `-` are refused; `GIT_TERMINAL_PROMPT=0` so git never waits on a prompt (Git Credential Manager can still use the saved login); an 8 minute limit, then the clone is killed and a folder it made is removed (below the server's 10 minute re-offer). Config `allowClone: false` turns it off on that PC (reported; the page says "Cloning is turned off on <PC>").
- **After the clone:** the worker scans and reports (so the new folder exists on the server with its git remote), writes the marker, trusts the folder (as linking does), launches Claude (the job's prompt as for any start) and returns `{ id, ok: true, folderId }`; the server links that folder to the project (only if it was unlinked) and moves the session into it. Progress: while cloning the worker sends `sessions: [{ sessionId, state: "starting", phase: "cloning" }]` every 30 s (keeps the row from going stale); `phase: "starting"` marks the clone done. The row reads "Cloning on <PC>…", then "starting", then open. A failure is the worker's plain sentence in `error` ("Couldn't clone: no access to owner/name; check that this PC is signed in to git", "Couldn't clone: the folder … is something else", "… took longer than 8 minutes, so it was stopped"); nothing is linked.
- **Trust of a clone:** trusted in Claude Code automatically only when it is clearly the owner's own world: (a) the job says `trusted: true` (the server compares who last set the project's repo, `codeBy`, with the PC's owner; missing = the project's owner), or (b) the worker already has another repo of the same host and owner on this PC (scan results, not counting the new folder or an owner it skipped trusting before). Otherwise it starts anyway and Claude Code shows its own trust dialog on first run; the result carries `untrusted: true` and the row reads "Waiting for you to trust this new repo on <PC>" for 10 minutes. This stops a teammate who can edit the project from getting a repo with hooks trusted on someone else's PC. "Same repo" for reuse compares host as well as owner/name.
- **Dispatcher:** a queued task with no folder of its project on any of the person's computers is claimed by a computer that can clone (or that has a scanned folder with the repo: linked first, then a normal start); otherwise the computer that has a folder takes it, as before.
- **UI:** Start sheet "Clone and start" (with "Pick a folder I already have instead"); Info › Code and the project's Claude tab show per computer "Not on <PC> yet. Claude will clone it into <projectsDir><name> when you start."; the Give to Claude sheet says the same.
- Not built: a "scan now" poke (a folder the person clones himself is offered for linking after the next scan, at most 15 minutes).

## Sessions list (Om's side)

- Buttons are labelled words: Start, Unlink (folders); Resume, Stop, Remove (sessions).
- `dead` (claude gone, no Stop job) reads "closed" in grey: the worker cannot tell Om closing the terminal from a crash. Red is only for `failed` (a launch error, with the reason). The worker needs claude to be missing on checks at least 20 s apart (after the 45 s launch grace) before reporting `dead`. Status reports only move live sessions (starting/running): a late report never revives a stopped, closed or failed one (Resume sets starting first).
- `running` reads "open on <device>": the worker only knows the claude process is alive, not that it is working (it may be sitting at a prompt).
- `starting` for more than 60 s (since the last update) reads "Waiting: check the terminal on <device>". After 3 minutes without news, a live session shows as "no news from its computer".
- A session whose folder is no longer linked to the project shows as "ended · folder unlinked": no Resume (the server refuses it too), Remove only. If it is still starting or running it keeps Stop, so a live process is never unreachable.
- Remove (stopped, failed, dead, or silent sessions only; refused for starting/running) sets `hidden: true` on the session doc. The doc is never deleted; the list just skips hidden sessions. The session must belong to the project.
- A stop job the worker answers with `unknown session` or `session not running` marks the session `stopped` on the server (nothing is left to stop), instead of leaving it running until it goes silent.

## Marker file: `.workos.json`

Written by the worker into a linked folder (when the link appears, and right before the first
start there):

```json
{ "v": 1, "project": "pms", "projectName": "PMS", "folderId": "f_3k9…", "writtenBy": "work-os-worker" }
```

- In a git folder, also add `.workos.json` to the local exclude file (`git rev-parse --git-path
  info/exclude`), so it is never committed. Never touch `.gitignore`.
- Only remove or rewrite markers with `"writtenBy": "work-os-worker"`.
- Claude Code sessions resolve their project in this order: nearest `.workos.json` (this folder
  or a parent) → git remote / subdir / branch (`get_project`) → ask Om.

## VS Code and Reopen after a restart

Added for Om's VS Code sessions (most of his sessions live in VS Code, and a crash or restart used to mean reopening each one by hand).

- **Where a session was made.** Each session in `claudeSessions` carries `origin`: `vscode` (transcript lines say `"entrypoint":"claude-vscode"`), `cli` (`"cli"`) or `other`. It is the LAST entrypoint in the transcript tail (where the session was last used); only that short token is read, nothing else on those lines. Server: `cleanClaudeSessions` accepts `origin` (optional, an unknown value is a 400).
- **Open in VS Code** (job kind `vscode`, `{id, kind, sessionId}`; no folder id, no prompt). Button on any session row on the Claude page (and on the project's sessions) when the computer is online. The server action (`openInVscodeAction`) only accepts a session the computer itself reported. The worker finds `~/.claude/projects/*/<sessionId>.jsonl`, reads the session's `cwd` (local only, never sent), and applies the checks a resume makes: the id is a UUID, the folder resolves (realpath) inside an allowed root, and it is at or below a scanned folder that is linked to a project (`locate()` in `worker/core.mjs`). Then, with `Code.exe` started directly with an argument array (never a shell, never `code.cmd`, never from PATH or inside an allowed root; standard install paths only: `%LOCALAPPDATA%\Programs\Microsoft VS Code`, Program Files, the macOS app): `Code.exe <folder>` (reuses the window already showing that folder), a wait of 8 s, then `Code.exe --open-url -- vscode://anthropic.claude-code/open?session=<id>` (what Windows runs for a `vscode://` link). The Claude Code extension opens the session in that window. `ELECTRON_RUN_AS_NODE` and `VSCODE_*` are removed from the environment. Opens run one at a time. `worker/vscode.mjs`.
- **VS Code asks once.** The first time, VS Code shows "Allow 'Claude Code for VS Code' to open this URI?"; Om answers Open (the checkbox makes it permanent). Work OS cannot and does not answer it. Checked by hand on Om's PC (VS Code with the extension 2.1.312, Windows 11): the folder window opens and the link reaches the extension, which showed this prompt.
- **Reopen after a restart.** Each status report (list built) the worker saves `state.openSet` (sessions in its list that are running: id, origin, title, folder name, time). At the first list after the worker starts, entries of the old set that are not running now become `state.reopen` (pending; older than 7 days dropped; at most 20). Pending ones leave it when they run again, on Reopen all or on Dismiss. A session closed normally while the worker ran leaves the set at the next report, so only sessions that vanished with the PC are offered (closing everything and shutting down within 2 minutes can still offer them: Dismiss). The status carries `reopen: [{sessionId, origin, title, folder}]` (always, `[]` when none; strict validation `cleanReopen`, at most 20, folder a name). No paths, no timestamps.
- **The prompt.** The Claude page (Now) and the project's Sessions show "N sessions were open before <PC> restarted" with the list (title, folder, where it reopens), **Reopen all** and **Dismiss** (`app/(app)/claude/reopen-banner.tsx`). Nothing is reopened without the tap. Reopen all queues a `reopen` job (no ids: the server cannot name sessions, the worker uses its own remembered list); Dismiss queues `dismiss`. Both clear the server copy at once. The worker reopens each session where it was made: `vscode` as above, anything else with `claude --resume` in Windows Terminal (like Resume, project name from the link). Sessions that are running again are skipped; ones that fail the checks are listed in the job result ("Opened 1 of 2: Link this folder to a project first").
- **Feedback.** After a tap the page polls `jobOutcomeAction` (about 1 minute) and toasts how it went. Failure reasons from the worker are shown in plain words (`lib/worker-errors.ts`, used for failed sessions on the Claude page and the project's sessions).
- Not verified: a cold start (VS Code not running, as after a reboot). The worker then waits 25 s instead of 8 s before sending the link; if that is still too short the link can be lost (tap again).

## Launching

- Windows: Windows Terminal, new window in the folder, running `node worker/run-claude.mjs <claude> <args>`. The wrapper
  runs `claude` (no shell, stdio inherited) and exits 0 when it ends, so the tab closes after Stop or a normal exit.
- Arguments: `--session-id <sessionId>` (start) or `--resume <sessionId>` (resume), no `--permission-mode` (the user's own Claude default applies),
  `--name <projectName>`, `--remote-control=<projectName>` (one token; the name is optional in claude, so it is attached with
  `=` and can never swallow the next argument), and the prompt as the last argument only when given. Every launched session
  shows up in the Claude app through Remote Control.
- macOS: Terminal.app via `osascript`, same arguments, every value single-quoted, followed by `; exit`.
- Liveness: a `claude`/`claude.exe` process (image name) whose command line has `--session-id <id>` or `--resume <id>`. The wrapper is not counted.
- Stop: end only that claude process tree; the wrapper then exits 0 and the tab closes.
- The folder must resolve (realpath) inside an allowed root; otherwise the job fails.
- Windows requires Windows Terminal (`wt.exe`). The cmd.exe fallback was removed; without wt.exe the job fails with "Install Windows Terminal (wt.exe)".
- Resume and open-in-VS Code also come from the remembered open set ("VS Code and Reopen after a restart").
- The worker launches an absolute `claude` path resolved once at startup (outside any allowed root), only in folders that are currently linked, and only acts on sessions it started (exact `--session-id`/`--resume <id>` match). Recently handled job ids are remembered so a re-offered job is not launched twice. Config `allowPrompts: false` makes the worker ignore job prompts.

## Folder trust

Linking = trusting (Om's decision, 2026-10-15). A folder turbo mode clones is linked by the worker and trusted the same way, before Claude starts. Claude's interactive "trust this folder" prompt appears before Remote
Control connects, so it cannot be answered from the phone. The worker therefore sets
`projects["<path>"].hasTrustDialogAccepted = true` in `~/.claude.json` (override the file with env `WORK_OS_CLAUDE_JSON`):
- when it sees a folder linked (where it writes `.workos.json`), and again right before every start/resume launch;
- only that one project entry; other keys and projects are never touched; a missing entry is created as `{ hasTrustDialogAccepted: true }`;
- keys use Claude's format (forward slashes, uppercase drive letter); an existing entry that differs only in slash style or drive-letter case is updated instead of duplicated;
- never untrusts, including on unlink;
- safe write: re-read right before writing, temp file in the same directory, rename; unparseable JSON is skipped and logged, never overwritten; 2-space JSON; no write at all if the flag is already true.

## Risk

Anyone who controls Work OS (the server, its database or Om's account) can start Claude sessions on linked folders and type prompts into them. Do not use bypassPermissions or auto mode in folders you link, and keep `allowPrompts` off if you do not need prompts from Work OS. Linking a folder also marks it trusted in Claude Code (see Folder trust).
