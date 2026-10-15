# Session launcher: contract between Work OS and the worker

Start, resume and stop Claude Code sessions on Om's machines from Work OS. Conversations go
through Claude's Remote Control (the Claude app), never through Work OS. Work OS is the control
panel; the worker is a small Node program on each machine.

## Rules (both sides)

1. Paths never leave the machine. Work OS knows folders by `folderId` + display `name` only.
2. The worker does exactly three things: start, resume, stop. It never runs commands from the
   server and launches `claude` with an argument array (no shell string, except the macOS
   Terminal script, which must quote every value).
3. A job's optional `prompt` is only ever text Om typed at Start. Work OS never fills it from a
   task, note, Discord or Claude.
4. Normal permission mode. Never `--dangerously-skip-permissions`, never `--bare`.
5. Status only: session id, folder, state. No transcripts, logs or code.
6. Outbound only. One device key per machine (`wkr_…`), revocable on Connect → Devices.
7. Kill switch: `enabled: false` in the worker config, or revoke the key.

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

Response: `{ "ok": true, "known": 112, "missing": 1 }`

### GET /api/worker/jobs: what to do now (poll every `pollSeconds`)

```json
{
  "enabled": true,
  "pollSeconds": 10,
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
- The worker launches an absolute `claude` path resolved once at startup (outside any allowed root), only in folders that are currently linked, and only acts on sessions it started (exact `--session-id`/`--resume <id>` match). Recently handled job ids are remembered so a re-offered job is not launched twice. Config `allowPrompts: false` makes the worker ignore job prompts.

## Risk

Anyone who controls Work OS (the server, its database or Om's account) can start Claude sessions on linked folders and type prompts into them. Do not use bypassPermissions or auto mode in folders you link, and keep `allowPrompts` off if you do not need prompts from Work OS.
