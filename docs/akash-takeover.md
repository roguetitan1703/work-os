# Handover to Akash: Claude sessions, turbo mode, chat porting

As of 2026-10-31. This covers the four Work OS asks you sent Om on 2026-10-30, what was built for each, why it was built that way, and what is still open. Read `docs/HANDOVER.md` for the whole product, and `docs/launcher.md` for the worker contract.

## Your asks and where they stand

| Ask | State | Where |
| --- | --- | --- |
| Open Claude Code in VS Code directly | Built, merged, in build `c3b39ed` | `worker/vscode.mjs`, `docs/launcher.md` "VS Code and Reopen after a restart" |
| Turbo mode (repo not on the PC: clone, link, start) | Built, merged, in build `c3b39ed` | `worker/clone.mjs`, `lib/data/turbo.ts`, `docs/launcher.md` "Turbo mode" |
| Recurring tasks | Already existed; now easier to find | `lib/quick-parse.ts` (`parseRepeat`), `lib/recurrence-options.ts` |
| Chat storage (move context between chats and tools) | Designed, not built | Section below |
| Why did my session show "failed"? | The reason now shows in plain words on desktop too | `lib/worker-errors.ts` |

The build `c3b39ed` is on the `manual-builds` release. The box runs it after `sudo work-os-update`. Before that, add the two `lb_try_*` lines to `/etc/caddy/sites/work-os.caddy` (see "Updates no longer 502" below).

## Two rules Om set for this work

1. **Design before building.** A new capability gets a short design first: the problem with a real example, the cases, the options, a recommendation. Om sees it, then it is built. Bugs and small fixes go straight in.
2. **Security must not hinder the work.** Keep a guard only when it stops a real attack that is not already possible another way. No default-off switches, narrow allow-lists or extra confirmations when the same person could already do worse. Example: anyone who can start a Claude session on a PC can already ask Claude to clone any repo, so the clone button is on by default.

## Open in VS Code and Reopen all

**What it does**
- Each session row has **Open in VS Code** next to Resume.
- The worker runs `Code.exe <folder>`. It waits 8 s, or 25 s if VS Code was not running, then runs `Code.exe --open-url -- vscode://anthropic.claude-code/open?session=<id>`. That link is the Claude Code extension's own URI handler; it calls `claude-vscode.primaryEditor.open`.
- **Reopen all:**
  - The worker saves the set of running sessions with every report.
  - After a restart it reports the ones no longer running.
  - The Claude page then shows "N sessions were open before your PC restarted", with Reopen all and Dismiss.
  - Each session opens where it was made, VS Code or terminal. The origin comes from the transcript's `entrypoint` (`claude-vscode` or `cli`).
  - Nothing reopens without the tap.

**Guards (kept after review)**
- `Code.exe` is taken only from the standard install paths, never PATH, and never from inside an allowed root.
- No shell. The URL goes after `--`.
- The worker removes `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS` from the environment it passes to VS Code.
- The job carries only a session id. The worker reads the folder from its own transcript, and that folder must sit inside a linked folder.
- A repeat open of the same session within 60 s is dropped, and there are at most 4 opens a minute.

**Not checked by hand yet**
- The first open shows VS Code's prompt "Allow 'Claude Code for VS Code' to open this URI?". Tick *do not ask again*.
- After that prompt, the session loading in the panel has not been seen.
- A cold start after a reboot, which relies on the 25 s guess.

## Turbo mode

**What it does.** Start Claude or Give to Claude, on a project whose repo is not on the PC. The worker:
1. Makes `<projectsDir>/<repo name>`. `projectsDir` defaults to the first scan root and can be changed in the worker config.
2. Runs `git clone`.
3. Links the folder to the project.
4. Starts Claude.

The row reads Cloning, then Starting, then open. If the repo is already there (a linked folder, or a scanned folder with the same git remote), it skips to the start. The task dispatcher follows the same path.

**Addresses.** Any `https://` or `ssh` git address works, as does `owner/name`. A project stores `owner/name` plus an optional `host`, and turns them into `https://<host>/owner/name.git`.

**Hard guards.** Each of these stops a real attack:
- Refused addresses: `ext::`, `fd::`, any `::` helper, `file:`, `git:`, `http:`, local paths, and anything starting with `-`. `ext::` would run a command on the PC.
- git runs as an argument list with `protocol.allow=never`, and only https and ssh switched on. No shell. `GIT_TERMINAL_PROMPT=0`.
- An 8-minute kill.
- The destination must stay inside `projectsDir`. A folder that holds a different repo gets a `-2` suffix, and repos are compared by host, owner and name.
- It only clones onto the person's own PCs. A teammate cannot trigger it.
- Local off switch: `allowClone: false` in the worker config. The default is true.

**Trust of a clone.** This came out of the security review.
- **Why it matters.** Marking a folder trusted in Claude Code lets the repo's `.claude/settings.json` hooks, `.mcp.json` and `CLAUDE.md` run with no prompt. A teammate who can edit a shared project's repo address could otherwise get their own repo trusted on someone else's PC.
- **When it is trusted automatically:**
  - **(a) The person set the address themselves.** Projects record `codeBy`; the server sends `trusted` in the clone job.
  - **(b) Same host and owner already on that PC.** For example, another `Delpat-Tech` repo is already there. The worker checks this from its own scan.
- **Otherwise** Claude Code shows its own trust dialog once. The row reads "Waiting for you to trust this new repo on <PC>".

**Tested.** Real clones of a public repo and of a private Delpat-Tech repo worked through `worker/clone.mjs` on Om's PC, using Git Credential Manager. A repo that is missing, or that the PC cannot access, gives a plain error. The full tap-to-Claude path is tested only against the stub worker (`tests/e2e/turbo.mjs`).

**Open**
- **A repo you clone by hand** is offered for Link only after the next 15-minute scan. A "scan now" push event would make that instant.
- **Nested GitLab groups** (`group/sub/repo`) are cut to the last two parts. Store the full URL for those.
- **No size cap** on a clone, only the 8-minute limit.

## Chat porting: design, not built

**The problem.** Context lives inside one tool's chat (Claude Code, Antigravity, others), and the next chat or tool cannot see it.

**Where the context lands.** A handover note on the Work OS project. Notes are plain text, so any tool can read them, and teammates see them. Claude sessions already read a project's notes before they start work.

**Ways to get it there, cheapest first:**
1. **The tool writes the note itself, over MCP.** Any tool that can use MCP servers connects to `https://work.delpat.in/api/mcp`, by sign-in or with a key. You then tell it "write a handover note for this project in Work OS". Om believes Antigravity supports MCP. **Next step: try it with Antigravity.** If it works, nothing needs building, except perhaps recording the writer as "Antigravity" rather than "Claude".
2. **Import chat.** For tools without MCP: a button on the project's Notes that takes a pasted chat or an exported `.md`/`.txt` file and saves it as a note marked *Imported chat (from <tool>, <date>)*. It is text only, so it does not need file uploads, which are still off.
3. **Make handover.** Starts a Claude session on the project with "read the imported chat note and write a short handover". This is a small add-on to Start Claude.

**Safety.** An imported chat is text another AI wrote and may contain instructions. Mark it the way teammates' text is marked (`writtenBy`), so Claude treats it as information, not orders.

**Recommendation.** Test (1) first. Build (2) only if (1) fails. Build (3) only if raw imports turn out too long to be useful.

**Claude to Claude, already working today:**
- **Resume** in Work OS, or `claude --resume`.
- A handover note written by the old session.
- `/export` in Claude Code.

## Updates no longer 502

`deploy/caddy/work-os.caddy` now has `lb_try_duration 30s` and `lb_try_interval 250ms` in both `reverse_proxy` blocks. While the app restarts during an update, Caddy keeps trying to connect for up to 30 s instead of answering 502. It retries only refused connections, so no request is sent twice.

The live file `/etc/caddy/sites/work-os.caddy` does not follow the repo. Add the two lines there by hand, then:

```
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

If 502s still appear during an update, check whether the app is being killed for memory while `npm ci` runs:

```
journalctl -u work-os --since "-1h" | grep -iE "killed|oom|memory|Started"
```

## Working on the code

- **Repos.** `roguetitan1703/work-os` is public and the main one: the box deploys from it and builds go to its `manual-builds` release. `Delpat-Tech/work-os` is a private mirror. Push master to both.
- **Before pushing,** check the diff for secrets: Atlas URIs, `wos_`/`wkr_`/`wosat_` keys, the server's address. The main repo is public.
- **Next.js 16.4.2** has breaking changes. Read the guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`).
- **Tests:**
  - `bash tests/e2e/run.sh` runs every suite against a throwaway mongod and app, and never touches the real database. `run.sh turbo vscode-reopen` runs only those suites.
  - Worker tests: `node --test test/*.test.mjs` in `worker/`.
  - Currently 33 suites; the `tenancy` "operator sees Usage" check failed once and passed on a rerun.
- **Deploying:**
  1. Build with `scripts/build-artifact.sh` (WSL or Linux).
  2. Upload the tarball and its `.sha256` to `manual-builds`.
  3. On the box, run `sudo work-os-update`.

  `work-os-update` only takes a build of the exact `origin/master` commit, so commit nothing to master after building (`docs/hosting.md` section 7).
- **Security reviews.** Anything touching auth, permissions, tokens, or what the server can make a PC run gets a security review before merge.
- **What's next** is ordered in `WORK-STATE.md`. Anything found along the way goes in its Later list.

## Your next steps

1. Read this file and `docs/launcher.md` (Turbo mode; VS Code and Reopen).
2. Once the box runs `c3b39ed`, try each of these once:
   - Turbo Start on a project that is not on your PC.
   - Open in VS Code, ticking "do not ask again".
   - Reopen all after a restart.
3. Try chat porting option 1 with Antigravity and tell Om what happens.
4. Note anything that breaks in Work OS as a task on the Work OS project.
