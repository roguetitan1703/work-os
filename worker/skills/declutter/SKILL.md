---
name: declutter
description: Tidy this session's Work OS project when it grew (the brief or end_work says "Declutter due", or your person says declutter, tidy up, clean up the State). Shows what Work OS proposes, finishes the lines that are this session's own or clearly done, and asks before touching anything other sessions or people hold.
---

Installed by the Work OS worker (it replaces this folder when a newer version ships; delete the `.work-os-managed` file to keep your own copy).

1. Call the Work OS `declutter` tool for this session's project (read only). If you have not called `start_work` for the project yet, do that first.
2. Check each proposal against the code and the disk (is the line really done, is the page really a repeat?). Show your person one short list: one line per item with its id, what would happen (done, archived line, archived page, task completed, Need withdrawn) and why.
3. Apply at once only what is this session's own or clearly done, in one `save_state` call:
   - `done_next {id}` for a Next line whose work is finished (its task is Done, or the commit is merged);
   - `archive_line {id, why}` for a Next or Later line that is stale or repeated, with the why in a few words.
   The line id is the item's `target`.
   A line is this session's own when it holds it (`get_state` shows who holds each line) or added it. Nothing is deleted: an archived line can be put back from the State card.
4. Ask before anything else: lines another session or a person holds, other people's tasks and Needs, pages, and anything you are not sure of.
   - While your person is in the conversation, ask them in chat, apply what they say yes to, and record the answer as a Decision (`save_state` `add_decision`).
   - When they are away, call `declutter` again with `ask: true`, `skip` (the ids you already applied or that should stay) and `disk` (worktrees, branches or files to remove after a yes): that files one Need to the project's owner, who ticks what goes in the app.
5. Say in one line what changed, what waits on an answer, and anything on the disk left for later.
