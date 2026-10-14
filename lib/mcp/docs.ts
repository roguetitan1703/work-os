// Single source for what Claude is told about Work OS: used by the MCP server
// (server instructions + tool descriptions) and by the /connect page.

import { ModeSchema } from '../types';
import { APP_TZ } from '../dates';

export const INSTRUCTIONS = `Work OS is Om's personal task system (solo founder of a software agency). You can read and update it.
- Tasks have a short number ("ref"); refer to them as #12. Any tool that takes "task" accepts 12, "#12" or the task id.
- Dates are calendar dates (YYYY-MM-DD) in ${APP_TZ}. Date inputs also accept today, tomorrow, a weekday name (next occurrence), +3d, +2w.
- Statuses: Not Started, In Progress, Blocked, Done, Dropped. Priorities: P1 (must ship today) … P4 (backlog).
- Modes (type of work): ${ModeSchema.options.join(', ')}.
- Every write you make is recorded in the task's history as done by Claude. Include a short "note" saying why, especially for status and progress changes.
- Use log_progress (not update_task) to report progress; use complete_task to finish a task. To abandon a task set status Dropped; to remove a task added by mistake use delete_task (it goes to a 30-day trash; restore_task brings it back).
- Notes are pages (markdown) for anything longer than a line or two: problem statements, handovers, drafts, client terms, idea lists. Keep task descriptions short and put the real content in a note. A task has at most one note; projects can have many. Reads (get_task, get_project, list_projects) show each note's id, title and first line: always update an existing note by note_id (or by task for a task's note) before creating a new one, and prefer append or edits over rewriting.
- Several changes at once (a handover, a cleanup, re-planning): use apply_changes, one atomic call; run it with dry_run first when it deletes or touches many tasks. For a full picture of a project use get_project (depth full) instead of many get_task calls.
- For the morning brief, call daily_summary once; it already contains overdue, due today, in progress, blocked, completions and changes since the previous workday.
- Discord (server "Delpat", read-only): discord_needs_attention is the one call for "what needs me on Discord". It lists items Om flagged for later by tagging the bot (with the message he was replying to), mentions of him/his roles/@everyone, replies to him, and new activity in threads he is in, each marked handled if he posted after it. The bot cannot post, so never claim to have replied on Discord. Use discord_message_to_task to turn a message into a task (it won't duplicate one already tracked).`;

/** Added to INSTRUCTIONS for Claude Code sessions (API keys from /connect), not for the claude.ai connector. */
export const CLAUDE_CODE_INSTRUCTIONS = `You are connected as Claude Code (a session on Om's PC). Your writes are recorded as "Claude Code".
- Start here: call get_project with your git remote (git remote get-url origin), your folder relative to the repo root (git rev-parse --show-prefix) and branch. If it says unmatched, ask Om which project this is and save it with update_project code, or create the project with add_project (code included) when it is new work.
- You can create and edit projects, tasks and notes, and move tasks and notes to trash (restorable). Permanent deletion and admin are not available.
- Limits per key: 300 tool calls per hour; 10 items moved to trash per 10 minutes. An apply_changes that trashes more than 10 items or changes more than 50 tasks must be run with dry_run: true first; the dry run returns a confirm token (valid 10 minutes) to pass as confirm with exactly the same ops.
- When you change the title, priority, due date or project of a task you did not create, or trash it, Om gets an inbox notice. Say why in the note.`;

export type ToolName =
  | 'list_tasks'
  | 'get_task'
  | 'add_task'
  | 'update_task'
  | 'log_progress'
  | 'complete_task'
  | 'add_comment'
  | 'apply_changes'
  | 'get_project'
  | 'delete_task'
  | 'restore_task'
  | 'list_trash'
  | 'write_note'
  | 'read_note'
  | 'list_notes'
  | 'delete_note'
  | 'update_checklist'
  | 'list_projects'
  | 'add_project'
  | 'update_project'
  | 'daily_summary'
  | 'recent_activity'
  | 'discord_needs_attention'
  | 'discord_list_channels'
  | 'discord_read_messages'
  | 'discord_message_to_task';

export const TOOLS: Record<ToolName, { title: string; description: string; writes: boolean; example: string }> = {
  daily_summary: {
    title: 'Daily summary',
    description:
      'One call for the morning brief: counts plus overdue, due today, in progress, blocked (incl. waiting on dependencies), due in the next 7 days, tasks completed since, all task changes since (with who made them), and per-project open/overdue counts. "since" defaults to the start of the previous workday (Monday → Friday).',
    writes: false,
    example: 'What changed since yesterday and what is on me today?',
  },
  list_tasks: {
    title: 'List tasks',
    description:
      'List/filter tasks. By default returns open (Not Started / In Progress / Blocked), non-archived tasks sorted by priority. Set include_closed or status to see Done/Dropped.',
    writes: false,
    example: 'Show my overdue Grant Leads tasks',
  },
  get_task: {
    title: 'Get task',
    description: 'Full detail for one task, including checklist, links, dependencies and its recent activity history.',
    writes: false,
    example: "What's the history on #42?",
  },
  add_task: {
    title: 'Add task',
    description: 'Create a task. Only title is required. Defaults: priority P2, status Not Started.',
    writes: true,
    example: 'Add a P1 for Terrah: send the revised quote, due Friday, 30 min',
  },
  update_task: {
    title: 'Update task',
    description:
      'Change fields on a task (title, description, project, mode, priority, status, tags, dates, estimate, links, blocked reason, dependencies, recurrence). Only fields you pass change. Changes are diffed into the history with your note.',
    writes: true,
    example: 'Move #31 to next Tuesday and make it P2',
  },
  log_progress: {
    title: 'Log progress',
    description:
      'Record a progress update: percent complete plus a note on what moved. Moves Not Started → In Progress automatically. Optionally change status (e.g. Blocked, with the reason in the note).',
    writes: true,
    example: '#18 is about 60% done, API is wired, UI left',
  },
  complete_task: {
    title: 'Complete task',
    description: 'Mark a task Done (progress 100). Recurring tasks automatically get their next occurrence created.',
    writes: true,
    example: 'Mark #12 done, invoice sent',
  },
  add_comment: {
    title: 'Add comment',
    description: 'Add a comment to a task’s history without changing any fields. To change or remove one of your own comments later, use apply_changes (edit_comment / delete_comment) with its id from get_task.',
    writes: true,
    example: 'Comment on #9: client wants the call moved to Thursday',
  },
  apply_changes: {
    title: 'Apply changes (batch)',
    description:
      'Many changes in ONE atomic call: all apply or none do. ops (max 100) run in order: create_task, update_task, log_progress, complete_task, add_comment, edit_comment, delete_comment, update_checklist, archive_task, delete_task, restore_task, write_note, delete_note, add_project, update_project. A create_task can set as:"$name" and later ops may use "$name" as the task (also in depends_on). delete_task needs the task title as a safety check and moves the task to a 30-day trash. dry_run:true runs everything then rolls back, so you can check the result first. Claude Code keys: a call that moves more than 10 items to trash or changes more than 50 tasks is refused unless it was dry-run first; the dry run returns a confirm token (10 minutes) to pass as confirm with exactly the same ops.',
    writes: true,
    example: 'Set up the Terrah handover: 6 tasks with dependencies and a comment on #31',
  },
  get_project: {
    title: 'Get project (nested)',
    description:
      'One call for a project’s full picture: stats, code locations and recent activity; depth "tasks" adds its open tasks (include_closed for all); depth "full" adds each task’s checklist, what it waits on, and recent history entries with their ids. Start here from a repo: instead of project, pass your git remote, path relative to the repo root (subdir) and branch (or an absolute path); the most specific code location wins (remote+subdir+branch, then remote+subdir or remote+branch, then remote, then longest path). If nothing matches it returns unmatched with candidate projects: ask Om which project, then call update_project with code.',
    writes: false,
    example: 'Give me the full state of the Grant Leads project',
  },
  delete_task: {
    title: 'Delete task',
    description:
      'Move a task (with its history) to the trash for 30 days. Requires the task’s title as confirmation, so a wrong ref can’t delete the wrong task. Use for tasks added by mistake; for real work that stopped, set status Dropped instead. Claude Code keys: at most 10 per 10 minutes.',
    writes: true,
    example: 'Delete #88, I added it twice',
  },
  restore_task: {
    title: 'Restore task',
    description: 'Bring a deleted task (and its history) back from the trash.',
    writes: true,
    example: 'Restore #88',
  },
  write_note: {
    title: 'Write note',
    description:
      'Create or update a note (a Notion-style page). Update by note_id, or by task (a task has one note; created if missing). New project note: project + title, only when no existing note fits (get_project / list_notes show what a project holds). New sub-page: parent_id + title. Change content with ONE of: block_ops (replace/insert/delete by block id from read_note; keeps formatting elsewhere; preferred), edits [{find, replace}] (rewrites only the block containing it), append (markdown at the end), or body (replaces the whole page). Link tasks/projects as [#12 Title](/tasks/12) or [Name](/projects/<id>); they become mentions. archived:true archives a note.',
    writes: true,
    example: 'Put the Terrah handover in a note on #76',
  },
  read_note: {
    title: 'Read note',
    description: 'A note by note_id, or the note of a task: its markdown, its blocks (id, type, markdown) for targeted edits, and its sub-pages.',
    writes: false,
    example: 'What are the client terms we noted for Grant Leads?',
  },
  list_notes: {
    title: 'List notes',
    description: 'Flat list of notes (id, title, first line, what it is attached to, last edited), newest first. Filter by project, state (active, archived, all), kind (task, project) and text search.',
    writes: false,
    example: 'Find the note about pricing',
  },
  delete_note: {
    title: 'Delete note',
    description: 'Delete a note (restorable for 30 days). Requires the note title as confirmation. Prefer updating or archiving.',
    writes: true,
    example: 'Delete the duplicate ideas note',
  },
  list_trash: {
    title: 'List trash',
    description: 'Deleted tasks still restorable, with who deleted them, why, and when they will be purged.',
    writes: false,
    example: 'What did we delete this week?',
  },
  update_checklist: {
    title: 'Update checklist',
    description: 'Add, check, uncheck or remove checklist items. Items are matched by number (1-based), id, or text.',
    writes: true,
    example: 'On #22 tick off "staging deploy" and add "send demo link"',
  },
  list_projects: {
    title: 'List projects',
    description: 'Projects/clients with open, overdue, in-progress, blocked and completed counts and a completion percentage.',
    writes: false,
    example: 'How is each client project tracking?',
  },
  add_project: {
    title: 'Add project',
    description: 'Create a project, optionally with code locations (code: [{remote, subdir?, branch?} or {path}]). If one with the same name exists it is returned instead.',
    writes: true,
    example: 'Create a project for Acme, client is Jane',
  },
  update_project: {
    title: 'Update project',
    description:
      'Rename a project or change its client, description, status (active, paused, done, archived) or code locations. code: [{remote: "owner/name" or any git URL, subdir?, branch?} or {path}] replaces the list, so include the existing ones you want to keep.',
    writes: true,
    example: 'Pause the Swiggy project',
  },
  discord_needs_attention: {
    title: 'Discord: needs attention',
    description:
      'What on Discord needs Om since a time (default: start of the previous workday, Asia/Kolkata): items he flagged for later by tagging the bot (with the message he replied to), mentions of him or his roles, @everyone/@here, replies to him, and new activity in threads he is in. Grouped by channel with jump links; each marked handled if he posted after it. Only channels active since the cutoff are read.',
    writes: false,
    example: 'Anything on Discord I need to deal with?',
  },
  discord_list_channels: {
    title: 'Discord: list channels',
    description:
      'Channels and active threads in the Delpat server with category/parent, type and last activity time; filter to those active since a time. Lists channels the bot cannot read separately.',
    writes: false,
    example: 'Which Discord channels were active today?',
  },
  discord_read_messages: {
    title: 'Discord: read messages',
    description:
      'Read messages from a channel or thread (by name, id or link): since a time, or before/after/around a message id. Each message has author (and whether it is Om), time, text, mentions, reply reference, attachment names, thread info and a jump link.',
    writes: false,
    example: 'What did the team say in #dev since this morning?',
  },
  discord_message_to_task: {
    title: 'Discord: message to task',
    description:
      'Create a Work OS task from a Discord message (by jump link, or channel + message id): title drafted from the message unless you pass one, description with the excerpt, author, channel and link; project/mode guessed from the channel. Returns the existing task instead if that message is already tracked.',
    writes: true,
    example: 'Make a task from that message in #client-terrah, due Friday',
  },
  recent_activity: {
    title: 'Recent activity',
    description: 'History feed across all tasks (status changes, progress, edits, notes, completions), newest first.',
    writes: false,
    example: 'What did I get done this week?',
  },
};
