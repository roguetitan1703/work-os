# Work OS worker

Small Node program (Node 20+, no npm dependencies) that lets Work OS start, resume and stop Claude Code sessions on this machine. Contract and security rules: `docs/launcher.md`. Outbound only; paths never leave the machine.

## Windows

1. Install Node 20+ and Windows Terminal (optional; falls back to cmd.exe).
2. Create `%APPDATA%\work-os-worker\config.json`:
   ```json
   { "baseUrl": "https://your-work-os.example", "deviceName": "my-pc", "roots": ["D:\\Work"], "enabled": true, "scanEveryMinutes": 15, "maxDepth": 6 }
   ```
3. Create a device key in Work OS (Connect, Devices) and store it: `node worker.mjs set-token` (paste, hidden; kept with DPAPI for your Windows user, never in config.json).
4. Check what will be reported: `node worker.mjs scan --dry`.
5. Run once to try: `node worker.mjs run`. Autostart at logon: `node worker.mjs install` (remove with `uninstall`).

## macOS

Same steps; config lives in `~/Library/Application Support/work-os-worker/config.json`, the key goes into the Keychain (service `work-os-worker`), sessions open in Terminal.app (allow Terminal automation when macOS asks), `install` adds a LaunchAgent.

## Remote Control

So you can talk to started sessions from the Claude app, turn on Remote Control for all sessions: set `"remoteControlAtStartup": true` in `~/.claude/settings.json`.

## Commands

`run` (default), `set-token`, `install`, `uninstall`, `status`, `scan [--dry]`. Kill switch: `"enabled": false` in config (picked up within 30 s) or revoke the key.

## Notes

- State (path to folder id, tracked sessions) is in `state.json` next to the config.
- Prompts starting with `-` get a leading space so `claude` never reads them as a flag.
- Tests: `node --test` in this folder (no real terminals, no real claude).
