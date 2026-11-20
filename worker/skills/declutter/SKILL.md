---
name: declutter
description: Tidy this session's Work OS project when it grew (the brief or end_work says "Declutter due", or your person says declutter, tidy up, clean up the State). Reads what Work OS proposes, applies the lines that are this session's own or clearly done, reviews the long lists and archives or merges lines, and asks only for what other people hold.
---

Installed by the Work OS worker (it replaces this folder when a newer version ships; delete the `.work-os-managed` file to keep your own copy).

1. Call the Work OS `declutter` tool for this session's project (read only). If you have not called `start_work` for the project yet, do that first. For a long State, `get_state` with `compact: true` shows every line with its date in a short form.
2. Check each proposed item against the code and the disk (is the line really done, is the page really a repeat?).
3. Apply your own clear items now: call `declutter` with `apply: [item ids]`. It archives lines, finishes Next lines, archives pages and completes tasks as you, recorded with each item's why. No Need. Nothing is deleted: an archived line can be put back from the State card.
4. If the answer has `review` (the State is long), go through its Next and Later lines, oldest first (each has id, date, waitsOn, text):
   - a feature or idea that is set aside goes to Parked with `save_state` `park_line {id, when}` (when: what would bring it back); what is done or no longer matters is archived with `archive_line {id, why}`;
   - merge related lines: `add_later` (or `add_next`) one line, then `archive_line` the rest;
   - then call `declutter` with `reviewed: true`. The project is due for size again only after 10 more lines.
5. Ask only for what other people hold: lines another session or a person holds, other people's tasks and Needs, pages, and anything you are not sure of.
   - While your person is in the conversation, ask them in chat, apply what they say yes to, and record the answer as a Decision (`save_state` `add_decision`).
   - When they are away, call `declutter` with `ask: true`, `skip` (the ids you already applied or that should stay) and `disk` (worktrees, branches or files to remove after a yes): that files one Need to the project's owner, who ticks what goes in the app.
6. Say in one line what changed, what waits on an answer, and anything on the disk left for later.
