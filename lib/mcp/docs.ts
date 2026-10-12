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
- Use log_progress (not update_task) to report progress; use complete_task to finish a task. There is no delete. To abandon a task set status Dropped.
- For the morning brief, call daily_summary once; it already contains overdue, due today, in progress, blocked, completions and changes since the previous workday.
- Discord (server "Delpat", read-only): discord_needs_attention is the one call for "what needs me on Discord". It lists items Om flagged for later by tagging the bot (with the message he was replying to), mentions of him/his roles/@everyone, replies to him, and new activity in threads he is in, each marked handled if he posted after it. The bot cannot post, so never claim to have replied on Discord. Use discord_message_to_task to turn a message into a task (it won't duplicate one already tracked).`;

export type ToolName =
  | 'list_tasks'
  | 'get_task'
  | 'add_task'
  | 'update_task'
  | 'log_progress'
  | 'complete_task'
  | 'add_note'
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
  add_note: {
    title: 'Add note',
    description: 'Add a note/comment to a task’s history without changing any fields.',
    writes: true,
    example: 'Note on #9: client wants the call moved to Thursday',
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
    description: 'Create a project. If one with the same name exists it is returned instead.',
    writes: true,
    example: 'Create a project for Acme, client is Jane',
  },
  update_project: {
    title: 'Update project',
    description: 'Rename a project or change its client, description or status (active, paused, done, archived).',
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
