# Work OS worker

Small Node program (Node 22+, no npm dependencies) that lets Work OS start, resume and stop Claude Code sessions on this machine. Contract and security rules: `docs/launcher.md`. Outbound only; paths never leave the machine.

## Setup

**From Work OS, without the repo (the way for teammates).** In Work OS open Claude, Setup, Computers, type a name and press Add. It shows the new key once and one command per OS (Windows PowerShell, macOS Terminal). The command downloads `/worker/work-os-worker.mjs` (the worker as one file, served by your Work OS) to a folder of your own (`%LOCALAPPDATA%\WorkOS` or `~/.work-os`), checks its sha256 against the one Work OS shows (that catches a damaged or half-finished download only: the file and the checksum come from the same Work OS, so it says nothing about who made them), and runs `setup --server <your Work OS>`. Paste the key when setup asks (hidden); it is never part of the command, so it stays out of your shell history. Setup first checks Node 22+ and Claude Code and says what is missing, with a link. The file unpacks the code into a `worker` folder beside it; autostart runs from there.

**Updating: the worker updates itself** (version 0.5.0 and later; `update.mjs`, docs/launcher.md "Self-update"). A worker installed with the command asks `/worker/latest.json` at start and every 6 hours. It installs a release only when all of this holds: the release version is higher than its own (no downgrades; release versions are the release commit's time, `YYYYMMDD.HHMMSS` UTC, set by the signing step and kept in `worker/RELEASE`, so nobody raises a number by hand), the release carries a signature, the signature (Ed25519, over the version and the bundle's sha256) was made by one of the public keys in its own `release-keys.mjs`, and the downloaded file has exactly the signed sha256. Then it writes the file beside the old one (`work-os-worker.mjs`, through a temp file and a rename), runs it with `unpack` (it only unpacks into the `worker` folder), and the supervisor restarts the worker on the code change; the new worker refreshes the installed hooks itself. Anything else (no signature, a bad one, an older version, a network error, a broken download) leaves the old code running, writes one line to `worker.log` and shows on Claude, Setup, Computers as "update refused: bad signature" or "update failed: <reason>" under the computer's worker version; the row also says when it last updated itself (`self-update.json` beside the config; `worker.mjs status` shows it). Whoever controls the server can serve any file but cannot sign one: the private key stays on Om's PC (`scripts/worker-signing-key.mjs`; `scripts/build-artifact.sh` signs on its own when the key is there). Runs from the repo never update themselves (update with git). A worker from before 0.5.0 cannot update itself: run the install command on it once more (settings and key are kept: press Enter at each question); the Computers row says "update available" for it and shows the command. To update by hand at any time, run the command again.

**From the repo.** Install Node 22+ (Windows also needs Windows Terminal; wt.exe). Create a device key in Work OS (Claude, Setup, Computers), then from the work-os repo run:
   ```
   node worker/worker.mjs setup
   ```
   It asks only for what is missing (server, device name, folder to scan, then the key, hidden), checks the key with one real call (a refused key stops it with "key refused"), stores the key with DPAPI or the Keychain (never in config.json), writes config.json, scans and reports folders, installs autostart, and installs the Work OS hooks into `~/.claude/settings.json` (one line says so; if that fails it says why and setup still finishes; see docs/setup-pc.md). Optional flags: `--server URL --name NAME --root DIR` (repeat `--root`) `--projects DIR` (where Work OS clones new repos; default: the first `--root`), `--no-autostart` (do not touch this PC's autostart: for tests and a second worker). Safe to rerun; existing settings such as `allowPrompts` are kept.
2. Open a project in Work OS, Sessions, and link a folder.

## Manual setup

Only if you do not want `setup`.

### Windows

1. Install Node 22+ and Windows Terminal (required; wt.exe).
2. Create `%APPDATA%\work-os-worker\config.json`:
   ```json
   { "baseUrl": "https://your-work-os.example", "deviceName": "my-pc", "roots": ["D:\\Work"], "enabled": true, "scanEveryMinutes": 15, "maxDepth": 6 }
   ```
3. Create a device key in Work OS (Connect, Devices) and store it: `node worker.mjs set-token` (paste, hidden; kept with DPAPI for your Windows user, never in config.json).
4. Check what will be reported: `node worker.mjs scan --dry`.
5. Run once to try: `node worker.mjs run`. Autostart at logon: `node worker.mjs install` (remove with `uninstall`).

Optional, for a second worker beside your own (e.g. a demo copy of Work OS): set `WORK_OS_WORKER_DIR` to its own config folder, and in its config.json `"mcpConfig": "<absolute path to an MCP config file>"` (sessions it starts get `--strict-mcp-config --mcp-config <file>`, so they only see the MCP servers in that file) and `"sessionsInRootsOnly": true` (only sessions in folders under its roots are listed and counted; nothing about other sessions on the PC is sent; a folder next to a root whose name starts with the root's name, e.g. `D:\demo-old` for root `D:\demo`, also passes, so give the root a distinctive name). Both are off by default.


### macOS

Same steps; config lives in `~/Library/Application Support/work-os-worker/config.json`, the key goes into the Keychain (service `work-os-worker`), sessions open in Terminal.app (allow Terminal automation when macOS asks), `install` adds a LaunchAgent.

## Risk

Anyone who controls Work OS (the server, its database or your account) can start sessions here and type prompts into them. Only linked folders can be launched. Sessions use your own Claude default permission mode; if that is auto or bypassPermissions, a prompt from Work OS runs without asking, so only link folders you are comfortable with. Set `"allowPrompts": false` in config.json to ignore prompts sent from Work OS. The worker reports this setting to Work OS, and the task dispatcher never gives a task to a worker that reports false (or does not report it, as older versions). Windows needs Windows Terminal (wt.exe); there is no cmd.exe fallback. Turbo mode: when a project's repo is not on this PC, Start from Work OS makes the worker clone it (git over https or ssh only, never a command-running transport, no prompts, 8 minute limit) into `projectsDir` (default: your first scan root) and start Claude there; set `"allowClone": false` in config.json to turn it off. Linking a folder also marks it as trusted in Claude Code (sets `hasTrustDialogAccepted` for that folder in `~/.claude.json`, never untrusts), so Claude skips its trust prompt there.

## Open in VS Code and reopen after a restart

Most Claude Code sessions live in VS Code, so Work OS can open one there: the worker runs `Code.exe <folder>`, waits a few seconds, then `Code.exe --open-url -- vscode://anthropic.claude-code/open?session=<id>`. It needs the Claude Code extension and VS Code in its usual install folder (`%LOCALAPPDATA%\Programs\Microsoft VS Code`, Program Files, or the macOS Applications folder). The first time, VS Code asks "Allow 'Claude Code for VS Code' to open this URI?"; answer Open (tick the box to stop it asking). The session's folder is read from its own history on this PC and must be inside an allowed root and linked to a project, as for Resume.

The worker also remembers which sessions were open. After the PC restarted or crashed, Work OS shows "N sessions were open before your PC restarted" with Reopen all and Dismiss; nothing opens without that tap. Each session reopens where it was made (VS Code, or a terminal with `claude --resume`). The memory is in `state.json` (session ids, where each was made, title, folder name; no paths). Code: `vscode.mjs`, `openset.mjs`.

## Remote Control

Every session the worker launches starts with `--remote-control=<project name>`, so it appears in the Claude app and you can talk to it there. Work OS never carries the conversation.

## Push

The worker keeps one stream open to Work OS (`GET /api/worker/stream`, `push.mjs`). Work OS uses it to say "poll now" when a session is started, resumed or stopped, a folder is linked, or a task is given to Claude, so jobs start within a second. While the stream is up the worker polls only every 5 minutes and sends its status only when something changed (every 2 minutes while a session it started runs); while it is down it polls as before (30 s, 10 s when busy). The log says `push connected` / `push disconnected`. An older Work OS without the stream: the worker tries again every 30 minutes and keeps polling meanwhile. The main loop is `loop.mjs`.

## Commands

`run` (default), `setup`, `set-token`, `install`, `uninstall` (also removes the hooks and the Work OS skills), `status` (shows the hooks version and the skills), `hooks install [--force] [--adopt NAME]|remove|status|check [folder]|repo [folder] [--server URL] [--project ID]` (`check` says whether a session in a folder gets the Work OS brief; `repo` puts the hooks and the skills into a repo for Claude Code on the web: docs/setup-pc.md "Cloud repos"), `scan [--dry]`, `activity [--titles]`.

## Skills (/transfer, /declutter)

The worker carries two Claude Code skills, `skills/transfer/SKILL.md` (hand a session's work over through Work OS, or pick a handover up) and `skills/declutter/SKILL.md` (tidy a project's State from the `declutter` tool's proposals). They come in the download and the signed bundle like the code. `hooks install` (and so `setup`) copies each to `~/.claude/skills/<name>/` with a `.work-os-managed` file holding its version (a hash of the text); at every start a worker whose hooks are installed refreshes them when it carries a newer version (after a self-update). `skills-install.mjs` does it.

- Only folders with `.work-os-managed` are ever replaced or removed. A folder of the same name without it is the person's own: it stays, and `hooks status` says `transfer: your own skill, not replaced`. Links are never followed.
- `hooks install --adopt transfer` replaces that one own folder after the person asks; the old folder moves to `<config folder>/skills-backup/transfer-<time>` (never left where Claude Code reads skills).
- `hooks remove` and `uninstall` remove only the marked folders. To keep your own edited copy of a Work OS skill, delete its `.work-os-managed` file.
- `hooks repo` writes the same folders into `<repo>/.claude/skills/` (same marker rule) for cloud sessions; commit them.
- The skill text is agent-facing: it uses the Words (docs/HANDOVER.md section 3) and `npm run check:words` scans it.

The scan offers git repos, folders with a project file (package.json, pyproject.toml, …) and every parent folder above them (below the root), so a client folder that holds several repos can be linked too.

Kill switch: `"enabled": false` in config (picked up within 30 s) or revoke the key.

## Notes

- Autostart (`install`) needs no administrator. Windows: a value `WorkOSWorker` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (it shows in Settings, Apps, Startup) that runs the supervisor hidden at every logon, and starts it now; an old `work-os-worker` scheduled task from earlier versions is removed if present. macOS: a LaunchAgent. If it cannot be set, setup says so in one line with the command to run the worker by hand and still finishes. `uninstall` removes it. One supervisor runs per config folder (`supervisor.pid`; a second start exits).
- Autostart runs `supervisor.mjs`, which runs `worker.mjs run` and restarts it when any worker `.mjs` file changes (after 15 s without further changes, and only if every file parses). Updating the worker never needs a reinstall. Output goes to `worker.log` next to the config (rotated at 1 MB).

- State (path to folder id, tracked sessions) is in `state.json` next to the config.
- Prompts starting with `-` get a leading space so `claude` never reads them as a flag.
- Sessions run through `run-claude.mjs` (a tiny wrapper that exits 0 when claude ends), so Stop also closes the Windows Terminal tab.
- Tests: `node --test` in this folder (no real terminals, no real claude).
