# Task dispatcher: Claude works tasks Om gives it

Status: design, not built. Om's decisions (2026-10-15) are marked **Om**.

## What it does

Om marks a real task "for Claude". When a computer has room, the server claims the task and has that computer's worker start a Claude Code session on it, in the project's folder. The session reads its rules and the task from Work OS, does the work, reports progress and finishes the task itself. Om is told when it finishes, stops without finishing, or gets stuck.

## Decisions

- **Om:** only real tasks Om marks are picked up. Never all tasks, and never Claude items. The Claude queue stays Claude's own housekeeping list.
- **Om:** at most 2 dispatched sessions run at once.
- **Om:** each session starts with the Claude Code boilerplate note (sub-agents, Delpat OS MCP for credentials, …).
- **Om:** claim before start; a task is never started twice.
- Sessions run on Om's PC through the existing worker, under his own subscription, so they have his normal Claude Code setup and MCP servers (Work OS, Delpat OS). Nothing runs in the cloud.

## Data (new optional fields, no migration)

On `tasks`:

```
claude: {
  state: 'queued' | 'running' | 'finished' | 'stopped' | 'failed',
  markedAt, markedBy: 'om',
  folderKey?: string,          // which linked folder, when the project has more than one
  sessionId?, deviceId?,       // set at claim
  claimedAt?, endedAt?, note?  // note: why it stopped/failed
} | null
```

Settings `dispatcher`: `{ enabled: boolean, maxConcurrent: 2, boilerplateNoteId: string }`.

## Marking (Om only)

- The task page and the row "…" menu get **Give to Claude** / **Take back from Claude**.
- This is a UI action (session cookie) only. MCP tools (Claude chat, Claude Code) and Discord **cannot** mark a task: a task's text becomes a prompt that runs on Om's PC, so only Om may choose what runs.
- Marking needs the project to have a linked folder. If there is more than one, Om picks one (same picker as Start Claude).
- Editing the title or description of a queued task keeps it queued; the prompt is built at claim time.
- Take back: queued → null. Running → it asks to Stop the session first.

## Claim and start (server, on the worker's jobs poll)

On `GET /api/worker/jobs` from device D, before returning jobs:

1. If the dispatcher is off, or D already has `maxConcurrent` dispatched sessions in `starting`/`running`, do nothing.
2. Pick the oldest queued task whose folder is linked on D and not missing, status not Done/Dropped/Blocked, not archived.
3. Claim it atomically: `findOneAndUpdate({ _id, 'claude.state': 'queued' }, { $set: { 'claude.state': 'running', claimedAt, deviceId, sessionId } })`. If that fails, someone else claimed it; stop.
4. Set the task In Progress (activity entry by "Claude Code (dispatcher)"), create the `workerSessions` row and the start job exactly as Start Claude does, with `dispatched: true` and the task id.
5. If creating the job fails, roll the claim back to queued.

The global cap counts dispatched sessions only; sessions Om starts by hand do not count.

## First message (built at claim time, ≤ 4000 characters, the worker limit)

```
You were given Work OS task #<ref> "<title>" (project <name>).
1. Read the note "<boilerplate title>" (read_note <id>) and follow it.
2. get_task <ref> for the full task, checklist and comments.
3. Do the work. log_progress as you go; ask Om with a Claude item (waiting on Om) if a decision is his.
4. When done: complete_task <ref> with a short summary. If you cannot finish, add_comment why and stop.
```

The boilerplate is read through the Work OS MCP rather than pasted in, because it is ~3.3k characters and changes; the message stays short and the session always gets the current version. If the read fails, the session still has the task.

## Ending and alerts

- A session ends (the worker reports it dead/stopped):
  - task Done → `claude.state = finished`, alert "Claude finished #12" (inbox, push, Discord per settings);
  - otherwise → `stopped`, alert "Claude stopped on #12 without finishing" with the last comment.
- Start job fails → `failed` with the error and an alert; the task goes back to what it was before the claim (status restored).
- Stuck: running more than 3 h with no `log_progress` / comment / checklist change for 90 min → one alert "Claude may be stuck on #12" (claimed-before-send, like other alerts). Nothing is killed automatically.
- Om can Stop from the Claude page as with any session; the task is then `stopped`.

## Where Om sees it

- Claude page, Now tab: a **Claude's tasks** section: running (with session), queued (in order), recently finished/stopped. Dispatcher on/off switch and the cap live in Claude › Setup.
- Task rows show a small "Claude" badge while queued or running.

## Safety

- Only Om marks tasks (above). The prompt only contains the task ref, title and project name; everything else is read by the session through the MCP under its own key.
- Cap of 2, global off switch, and the existing worker kill switch (`enabled: false`) and key revoke.
- Claim is a single conditional update; the start job is the existing one, validated by the worker as today (folder must be linked and inside roots).
- Policy: modest concurrency with Om reviewing output; no scheduling around the clock.

## Open

- Whether queued tasks start in task order (priority, due) or in the order Om marked them. Proposed: P1 first, then due date, then marked time.
- Whether a finished session should open a PR/branch by itself (left to the boilerplate and the task text for now).
