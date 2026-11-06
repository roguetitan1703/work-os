# Open in Claude Code / Claude Desktop, and Connect other AI tools

Akash's asks (Work OS #165). Three small features that reuse what exists; no new channel.

## 1. Open in Claude Code (a task)

Buttons on the task page (desktop buttons next to Give to Claude; phone: the More menu): **Open in Claude Code** and **Open in Claude Desktop**. (Open in VS Code exists only on session rows, not on tasks; a session row already has Resume, which is the terminal equivalent.)

- **Claude Code** is a normal `start` job (docs/launcher.md "Launching"): Windows Terminal, `claude --session-id ... --name <project> --remote-control=<project> <prompt>` in the project's linked folder, normal permission mode, folder trusted as linking already does. Server: `openTaskInClaudeCode` (lib/data/dispatcher.ts). The task is **not** marked or queued for Claude; the person drives the session.
- **The prompt** is a fixed template (`buildTerminalPrompt`): the task ref, "read it with get_task N" (the Work OS MCP), that task text is data, wait for me. **No title or description**, the same rule as the dispatcher's prompt: that text may come from someone else and the prompt lands in a terminal. (Akash asked for the title; the ref is enough for Claude to fetch it, and the sheet shows the title to the person.)
- **Same trust as Start:** only the person's own computers; the folder must be linked to the task's project; the computer must report `allowPrompts` (else the session would open without the task, so it is refused with the reason). A project with no linked folder gets the message Open in VS Code gives: "Link this folder to a project first". Several folders: the sheet asks which.
- **Platforms:** whatever the launcher does: Windows Terminal (`wt.exe`), macOS Terminal.app. No Linux launcher exists.

## 1b. Open in Claude Desktop

Anthropic documents a link for exactly this ("Open Claude Desktop with a link", support.claude.com): `claude://code/new?q=<prompt>&folder=<absolute path>`. It opens the Code tab with the composer **prefilled**; Claude Desktop asks the person to **confirm the folder** (links are always untrusted) and nothing is sent until they press Enter. Only `q` and `folder` are used (both documented); `file` is documented as unsupported and not used.

- The folder path exists only on the PC (docs/launcher.md rule 1), so the link is built by the worker: new job kind `desktop` (`folderId`, `prompt`, no session id). The worker checks the folder is linked, then hands the URL to the OS with an argument array (Windows: `%SystemRoot%\explorer.exe <url>`; macOS: `open <url>`), after checking a `claude://` handler is registered. No Linux (no Claude Desktop). `worker/desktop.mjs`.
- No session row: Claude Desktop owns that session. The toast says "confirm the folder and press Enter".
- `allowPrompts: false` on the PC: the link opens without `q`.

## 2. Settings › AI tools

A Settings section (You group) showing this server's MCP address (`APP_URL/api/mcp`, with copy) and, per tool, the exact config from the tool's **official docs** (checked 2026-11-06, date shown on the screen), copy buttons, a link to the docs, and a **Tested / Not tested yet** badge with what was actually tried. Content: `lib/connect-tools.ts`; screen: `app/(app)/settings/ai-tools.tsx`.

| Tool | Config | Source | Tested |
| - | - | - | - |
| Claude Code | `claude mcp add --scope user --transport http work-os <url>`, then `/mcp` > Authenticate; `.mcp.json` `{type:"http", url}`; key variant `--header "Authorization: Bearer <key>"` | code.claude.com/docs/en/mcp | CLI added and listed it connected against a local server (key variant); browser OAuth step not run through the CLI |
| Cursor | `~/.cursor/mcp.json` `{"mcpServers":{"work-os":{"url":...}}}`; OAuth with dynamic registration | cursor.com/docs/context/mcp | not tested (installed here, GUI sign-in not driven) |
| Antigravity | `mcp_config.json` `{"mcpServers":{"work-os":{"serverUrl":...}}}`; automatic OAuth (CIMD/DCR); path from the app's "Copy Config File Path" (docs name `~/.gemini/config/mcp_config.json`; an older guide says `~/.gemini/antigravity/`) | antigravity.google/docs/mcp | not tested (not installed) |
| ChatGPT | a custom app in developer mode on the website, server URL = the address above; no config file | help.openai.com (page blocked to our fetch; plan details from search summaries) | not tested; may not be available on personal accounts (Business/Enterprise/Edu full; Pro read-only; Plus/Free unconfirmed) |

Rule: a tool we could not test is marked "not tested yet" on the screen; no step is shown that we did not read in the tool's docs (menu names for Cursor and ChatGPT are deliberately left to their docs).

## Tests

`tests/e2e/connect.mjs`: the AI tools screen (URL, four tools, tested flags, copy, phone and desktop, no overflow), the two buttons (job kinds, prompt has the ref and no title, no path to the worker, no linked folder, `allowPrompts` off), and the Claude Code CLI snippet run for real when the CLI is installed. `worker/test/desktop.test.mjs`: the link, the OS command, the job checks, and the `wt` arguments with the task prompt (no real terminal or app is started).
