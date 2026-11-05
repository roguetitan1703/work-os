# Subtasks (design, #183 and Akash's "task linking … hierarchical like threads" in #165)

Status: built (2026-11) as designed below. Code: "Subtasks" in `lib/data/tasks.ts`, `components/subtasks.tsx`; tests
`tests/e2e/subtasks.mjs` plus a subtask case in `tenancy` and `leak-audit`. See "As built" at the end.

## Problem

Related work becomes many flat tasks. Example: the KYC demo became #175 to #182, eight separate tasks made with eight
calls, and nothing on screen says they belong together or how far along the whole demo is. Tasks can already be
linked by "Blocked by" (`dependsOn`); what is missing is "part of".

## Proposal

- **Data.** A task gets `parentId: string | null`. One level only: a subtask cannot have subtasks of its own (that
  covers the KYC case and keeps lists readable; a deeper split is a sign the parent should be a project).
- **Same place as the parent.** A subtask is in the parent's project and takes its visibility, `sharedWith` and owner
  rules through the same cascade as every other task in the project. Moving the parent to another project moves its
  subtasks with it.
- **Rollup.** A parent with subtasks shows "3 of 8 done" and a progress bar = the average of its open-or-done
  subtasks' progress (Done counts 100, Dropped is left out). The parent's own `progress` is recomputed whenever a
  subtask changes, so lists, Today and MCP read one number. Its checklist still works and is separate.
- **Completing a parent with open subtasks.** Allowed. The UI asks "Close the 5 open subtasks too?" (Close them /
  Leave them open). MCP `complete_task` leaves them open and lists them in its answer.
- **Trash.** Deleting a parent sends its subtasks to the trash with it; restoring it brings them back.
- **Lists.** Subtasks stay real tasks (own assignees, due date, status, Claude). In lists and the board they show a
  small "in <parent title>" line; a parent shows the "3/8" chip. The task page has a Subtasks section: add (title,
  Enter), tick done, open, detach.
- **Recurring parent.** The next occurrence copies the subtasks' titles as new open subtasks (like the checklist).

## MCP

- `add_task` takes `parent` (task ref) and `subtasks: [{ title, … }]` to make a parent and its children in one call;
  `update_task` takes `parent` (move under / `null` to detach). `get_task` returns `parent` and `subtasks` with their
  status and progress; `list_tasks` takes `parent`.
- Tool text says when to use which: a **subtask** is a deliverable someone tracks on its own (its own assignee, due
  date, status or Claude run); a **checklist item** is a step the same person does inside the task.
- `add_task` points at `apply_changes` for two or more writes, and the server instructions say "for 2 or more writes,
  use apply_changes". No rename: renaming breaks saved prompts and other clients, and a second alias tool adds a tool
  to every list.

## Recommendation

Build as above. Cost: medium (model + rollup, task page section, row chips, MCP, e2e). It is not a permissions
change, but subtasks inherit visibility, so the leak-audit and tenancy suites get a subtask case.

## As built

- **Stored:** a subtask has `parentId` with the parent's `parentRef` and `parentTitle` copied (renaming the parent
  updates them), so every list can show "in <parent>" without another read. A parent has `subtaskCount: { done, total }`
  (Dropped left out) next to its `progress`; `rollUp` recomputes both whenever a subtask is added, changes status or
  progress, moves, is trashed or restored. A closed parent keeps its own progress (100 when Done); reopening it takes
  the average again.
- **Where it lives:** `placeUnder` = `placeIn(parent's project, owner)`; with no project the subtask is private to the
  parent's owner. A subtask asked to change project is refused; moving the parent runs `moveSubtasks` (each gets a
  "Moved with #N" history line; an assignee who can't see it there is dropped). The move rules (owner-only out of a
  shared project) are checked on the parent only: its owner moves the whole group.
- **Trash:** the parent's subtasks go with it (`withParent` on their trash entries, hidden from the trash list, purged
  with it); restoring a subtask alone while its parent is in the trash is refused with "restore #N". A subtask trashed
  on its own goes back under its parent if the parent is still there, else on its own.
- **App:** the "Close the N open subtasks too?" question is asked by the row tick (desktop and phone), the task page's
  Complete / Mark done. Setting status Done from a status menu, the board drag or the day plan leaves them open (as MCP).
