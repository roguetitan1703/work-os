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
- For the morning brief, call daily_summary once; it already contains overdue, due today, in progress, blocked, completions and changes since the previous workday.`;

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
  | 'recent_activity';

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
  recent_activity: {
    title: 'Recent activity',
    description: 'History feed across all tasks (status changes, progress, edits, notes, completions), newest first.',
    writes: false,
    example: 'What did I get done this week?',
  },
};
