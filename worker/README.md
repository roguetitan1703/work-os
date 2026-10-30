# Work OS worker

Small Node program (Node 22+, no npm dependencies) that lets Work OS start, resume and stop Claude Code sessions on this machine. Contract and security rules: `docs/launcher.md`. Outbound only; paths never leave the machine.

## Setup

**From Work OS, without the repo (the way for teammates).** In Work OS open Claude, Setup, Computers, type a name and press Add. It shows the new key once and one command per OS (Windows PowerShell, macOS Terminal). The command downloads `/worker/work-os-worker.mjs` (the worker as one file, served by your Work OS) to a folder of your own (`%LOCALAPPDATA%\WorkOS` or `~/.work-os`), checks its sha256 against the one Work OS shows (that catches a damaged or half-finished download only: the file and the checksum come from the same Work OS, so it says nothing about who made them), and runs `setup --server <your Work OS>`. Paste the key when setup asks (hidden); it is never part of the command, so it stays out of your shell history. Setup first checks Node 22+ and Claude Code and says what is missing, with a link. The file unpacks the code into a `worker` folder beside it; autostart runs from there.

**Updating.** The worker asks `/worker/latest.json` at start and every 6 hours; if Work OS serves a different bundle it writes "a newer worker is available" to `worker.log`, and Claude, Setup, Computers shows "update available" on that computer (the worker reports which bundle it runs, 12 characters of its sha256). To update, run the same command again (settings and key are kept: press Enter at each question); the supervisor restarts the worker on its own when the unpacked code changes. The worker never downloads or swaps its own code: code arriving from the server would let anyone who controls the server run programs on every teammate's computer, so a person pastes the command (with its checksum) each time. Runs from the repo never ask.

**From the repo.** Install Node 22+ (Windows also needs Windows Terminal; wt.exe). Create a device key in Work OS (Claude, Setup, Computers), then from the work-os repo run:
   ```
   node worker/worker.mjs setup
   ```
   It asks only for what is missing (server, device name, folder to scan, then the key, hidden), checks the key with one real call (a refused key stops it with "key refused"), stores the key with DPAPI or the Keychain (never in config.json), writes config.json, scans and reports folders, and installs autostart. Optional flags: `--server URL --name NAME --root DIR` (repeat `--root`) `--projects DIR` (where Work OS clones new repos; default: the first `--root`). Safe to rerun; existing settings such as `allowPrompts` are kept.
2. Open a project in Work OS, Sessions, and link a folder.

## Manual setup

Only if you do not want `setup`.

### Windows

1. Install Node 20+ and Windows Terminal (required; wt.exe).
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

## Remote Control

Every session the worker launches starts with `--remote-control=<project name>`, so it appears in the Claude app and you can talk to it there. Work OS never carries the conversation.

## Push

The worker keeps one stream open to Work OS (`GET /api/worker/stream`, `push.mjs`). Work OS uses it to say "poll now" when a session is started, resumed or stopped, a folder is linked, or a task is given to Claude, so jobs start within a second. While the stream is up the worker polls only every 5 minutes and sends its status only when something changed (every 2 minutes while a session it started runs); while it is down it polls as before (30 s, 10 s when busy). The log says `push connected` / `push disconnected`. An older Work OS without the stream: the worker tries again every 30 minutes and keeps polling meanwhile. The main loop is `loop.mjs`.

## Commands

`run` (default), `setup`, `set-token`, `install`, `uninstall`, `status`, `scan [--dry]`, `activity [--titles]`.

The scan offers git repos, folders with a project file (package.json, pyproject.toml, …) and every parent folder above them (below the root), so a client folder that holds several repos can be linked too.

Kill switch: `"enabled": false` in config (picked up within 30 s) or revoke the key.

## Notes

- Autostart (`install`) needs no administrator. Windows: a value `WorkOSWorker` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (it shows in Settings, Apps, Startup) that runs the supervisor hidden at every logon, and starts it now; an old `work-os-worker` scheduled task from earlier versions is removed if present. macOS: a LaunchAgent. If it cannot be set, setup says so in one line with the command to run the worker by hand and still finishes. `uninstall` removes it. One supervisor runs per config folder (`supervisor.pid`; a second start exits).
- Autostart runs `supervisor.mjs`, which runs `worker.mjs run` and restarts it when any worker `.mjs` file changes (after 15 s without further changes, and only if every file parses). Updating the worker never needs a reinstall. Output goes to `worker.log` next to the config (rotated at 1 MB).

- State (path to folder id, tracked sessions) is in `state.json` next to the config.
- Prompts starting with `-` get a leading space so `claude` never reads them as a flag.
- Sessions run through `run-claude.mjs` (a tiny wrapper that exits 0 when claude ends), so Stop also closes the Windows Terminal tab.
- Tests: `node --test` in this folder (no real terminals, no real claude).
