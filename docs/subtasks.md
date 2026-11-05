# Subtasks (design, #183 and Akash's "task linking … hierarchical like threads" in #165)

Status: design with recommended defaults, built after builders A (sharing) and B (multiple assignees) merge, because
all three change `lib/data/tasks.ts`.

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
