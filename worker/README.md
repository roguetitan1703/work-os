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

## Risk

Anyone who controls Work OS (the server, its database or your account) can start sessions here and type prompts into them. Only linked folders can be launched. Sessions use your own Claude default permission mode; if that is auto or bypassPermissions, a prompt from Work OS runs without asking, so only link folders you are comfortable with. Set `"allowPrompts": false` in config.json to ignore prompts sent from Work OS. Windows needs Windows Terminal (wt.exe); there is no cmd.exe fallback.

## Remote Control

Every session the worker launches starts with `--remote-control=<project name>`, so it appears in the Claude app and you can talk to it there. Work OS never carries the conversation.

## Commands

`run` (default), `set-token`, `install`, `uninstall`, `status`, `scan [--dry]`. Kill switch: `"enabled": false` in config (picked up within 30 s) or revoke the key.

## Notes

- State (path to folder id, tracked sessions) is in `state.json` next to the config.
- Prompts starting with `-` get a leading space so `claude` never reads them as a flag.
- Sessions run through `run-claude.mjs` (a tiny wrapper that exits 0 when claude ends), so Stop also closes the Windows Terminal tab.
- Tests: `node --test` in this folder (no real terminals, no real claude).
