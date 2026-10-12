import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import * as tasks from '../data/tasks';
import * as projects from '../data/projects';
import { briefTask, dailySummary } from '../data/summary';
import { InputError, NotFoundError } from '../data/errors';
import { describeActivity } from '../activity-text';
import { APP_TZ, addDays, isDateStr, startOfDay, todayStr, weekday } from '../dates';
import { ModeSchema, PrioritySchema, ProjectStatusSchema, RecurrenceSchema, StatusSchema, type Task, type TaskPatch } from '../types';

const ACTOR = 'claude' as const;

const INSTRUCTIONS = `Work OS is Om's personal task system (solo founder of a software agency). You can read and update it.
- Tasks have a short number ("ref"); refer to them as #12. Any tool that takes "task" accepts 12, "#12" or the task id.
- Dates are calendar dates (YYYY-MM-DD) in ${APP_TZ}. Date inputs also accept today, tomorrow, a weekday name (next occurrence), +3d, +2w.
- Statuses: Not Started, In Progress, Blocked, Done, Dropped. Priorities: P1 (must ship today) … P4 (backlog).
- Modes (type of work): ${ModeSchema.options.join(', ')}.
- Every write you make is recorded in the task's history as done by Claude. Include a short "note" saying why, especially for status and progress changes.
- Use log_progress (not update_task) to report progress; use complete_task to finish a task. There is no delete. To abandon a task set status Dropped.
- For the morning brief, call daily_summary once; it already contains overdue, due today, in progress, blocked, completions and changes since the previous workday.`;

type Ctx = { baseUrl: string };

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof ZodError) return fail(err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (err instanceof InputError || err instanceof NotFoundError) return fail(err.message);
      console.error('[mcp]', err);
      return fail('Internal error');
    }
  };
}

const taskKey = z.union([z.number().int(), z.string()]).describe('Task ref (12 or "#12") or task id');
const dateArg = z.string().describe('YYYY-MM-DD, today, tomorrow, a weekday name, +3d …');

function parseSince(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const v = s.trim().toLowerCase();
  const today = todayStr();
  if (v === 'yesterday') return startOfDay(addDays(today, -1));
  if (v === 'today') return startOfDay(today);
  if (v === 'last_workday' || v === 'previous_workday') {
    let d = addDays(today, -1);
    while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, -1);
    return startOfDay(d);
  }
  const rel = v.match(/^(\d+)\s*(h|d)$/);
  if (rel) return new Date(Date.now() - Number(rel[1]) * (rel[2] === 'h' ? 3_600_000 : 86_400_000));
  if (isDateStr(v)) return startOfDay(v);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  throw new InputError(`Couldn't read "since" value "${s}"`);
}

async function fullTask(key: string | number, ctx: Ctx, activityLimit = 20) {
  const d = await tasks.getTaskDetail(key, { activityLimit });
  if (!d) throw new NotFoundError(`Task ${key} not found`);
  const t = d.task;
  return {
    ref: t.ref,
    id: t.id,
    url: `${ctx.baseUrl}/tasks/${t.ref}`,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    progress: t.progress,
    project: d.project?.name ?? null,
    mode: t.mode,
    tags: t.tags,
    due: t.due,
    start: t.start,
    estimateMins: t.estimateMins,
    overdue: tasks.isOverdue(t),
    blockedReason: t.blockedReason || undefined,
    checklist: t.checklist.map((i, n) => ({ n: n + 1, text: i.text, done: i.done })),
    links: t.links,
    dependsOn: d.dependencies.map(x => ({ ref: x.ref, title: x.title, status: x.status })),
    blocks: d.dependents.map(x => ({ ref: x.ref, title: x.title, status: x.status })),
    recurrence: t.recurrence,
    archived: t.archived,
    createdAt: t.createdAt,
    createdBy: t.createdBy,
    updatedAt: t.updatedAt,
    doneAt: t.doneAt,
    doneBy: t.doneBy,
    activity: d.activity.map(a => ({ at: a.at, by: a.actor, type: a.type, text: describeActivity(a) })),
  };
}

async function brief(t: Task, ctx: Ctx) {
  const names = await projects.projectNameMap();
  return briefTask(t, names, { baseUrl: ctx.baseUrl });
}

// snake_case tool args → service input
type FieldArgs = {
  title?: string;
  description?: string;
  project?: string | null;
  mode?: z.infer<typeof ModeSchema> | null;
  priority?: z.infer<typeof PrioritySchema>;
  status?: z.infer<typeof StatusSchema>;
  tags?: string[];
  due?: string | null;
  start?: string | null;
  estimate_mins?: number | null;
  progress?: number;
  checklist?: string[];
  links?: string[];
  blocked_reason?: string;
  depends_on?: (string | number)[];
  recurrence?: z.infer<typeof RecurrenceSchema> | null;
};

function toPatch(a: FieldArgs): TaskPatch {
  const p: TaskPatch = {};
  if (a.title !== undefined) p.title = a.title;
  if (a.description !== undefined) p.description = a.description;
  if (a.project !== undefined) p.project = a.project;
  if (a.mode !== undefined) p.mode = a.mode;
  if (a.priority !== undefined) p.priority = a.priority;
  if (a.status !== undefined) p.status = a.status;
  if (a.tags !== undefined) p.tags = a.tags;
  if (a.due !== undefined) p.due = a.due;
  if (a.start !== undefined) p.start = a.start;
  if (a.estimate_mins !== undefined) p.estimateMins = a.estimate_mins;
  if (a.progress !== undefined) p.progress = a.progress;
  if (a.checklist !== undefined) p.checklist = a.checklist;
  if (a.links !== undefined) p.links = a.links;
  if (a.blocked_reason !== undefined) p.blockedReason = a.blocked_reason;
  if (a.depends_on !== undefined) p.dependsOn = a.depends_on;
  if (a.recurrence !== undefined) p.recurrence = a.recurrence;
  return p;
}

const fieldShape = {
  description: z.string().optional().describe('Longer detail / context (markdown ok)'),
  project: z.string().nullable().optional().describe('Project or client name (or id). Created if it does not exist; null clears'),
  mode: ModeSchema.nullable().optional(),
  priority: PrioritySchema.optional(),
  tags: z.array(z.string()).optional(),
  due: dateArg.nullable().optional(),
  start: dateArg.nullable().optional().describe('Date work should start'),
  estimate_mins: z.number().int().min(0).nullable().optional(),
  checklist: z.array(z.string()).optional().describe('Checklist items (on update this replaces the list; prefer update_checklist)'),
  links: z.array(z.string()).optional().describe('URLs'),
  blocked_reason: z.string().optional().describe('Setting this on an open task marks it Blocked'),
  depends_on: z.array(z.union([z.number().int(), z.string()])).optional().describe('Refs of tasks this one waits on'),
  recurrence: RecurrenceSchema.nullable().optional().describe('Repeat after completion: {freq: daily|weekdays|weekly|monthly, interval}'),
};

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'work-os', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List/filter tasks. By default returns open (Not Started / In Progress / Blocked), non-archived tasks sorted by priority. Set include_closed or status to see Done/Dropped.',
      inputSchema: {
        status: z.array(StatusSchema).optional(),
        include_closed: z.boolean().optional().describe('Include Done and Dropped tasks'),
        project: z.string().optional(),
        mode: ModeSchema.optional(),
        tag: z.string().optional(),
        priority: z.array(PrioritySchema).optional(),
        due: z.enum(['overdue', 'today', 'today_or_overdue', 'this_week', 'next_7_days', 'no_date', 'has_date']).optional(),
        due_from: z.string().optional().describe('YYYY-MM-DD inclusive'),
        due_to: z.string().optional().describe('YYYY-MM-DD inclusive'),
        done_since: z.string().optional().describe('YYYY-MM-DD: only tasks completed on/after this date (implies Done)'),
        query: z.string().optional().describe('Text search in title, description and tags'),
        archived: z.boolean().optional().describe('true = only archived tasks'),
        sort: z.enum(['priority', 'due', 'updated', 'created', 'done']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      const all = await tasks.listTasks({
        status: a.done_since ? ['Done'] : a.status,
        open: !a.status?.length && !a.include_closed && !a.done_since,
        project: a.project,
        mode: a.mode,
        tag: a.tag,
        priority: a.priority,
        due: a.due,
        dueFrom: a.due_from,
        dueTo: a.due_to,
        doneFrom: a.done_since,
        q: a.query,
        archived: a.archived ? 'only' : 'exclude',
        sort: a.sort ?? (a.done_since ? 'done' : 'priority'),
      });
      const limit = a.limit ?? 50;
      const names = await projects.projectNameMap();
      return {
        today: todayStr(),
        total: all.length,
        returned: Math.min(limit, all.length),
        tasks: all.slice(0, limit).map(t => briefTask(t, names, { baseUrl: ctx.baseUrl })),
      };
    }),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Full detail for one task, including checklist, links, dependencies and its recent activity history.',
      inputSchema: { task: taskKey, activity_limit: z.number().int().min(1).max(200).optional().describe('Default 20') },
      annotations: { readOnlyHint: true },
    },
    handler(async a => fullTask(a.task, ctx, a.activity_limit)),
  );

  server.registerTool(
    'add_task',
    {
      title: 'Add task',
      description: 'Create a task. Only title is required. Defaults: priority P2, status Not Started.',
      inputSchema: {
        title: z.string().min(1),
        ...fieldShape,
        status: StatusSchema.optional(),
        note: z.string().optional().describe('Why/where this came from; stored in the history'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async a => {
      const { note, ...fields } = a;
      const t = await tasks.createTask({ ...toPatch(fields), title: a.title }, ACTOR, { note });
      return { created: await brief(t, ctx) };
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Change fields on a task (title, description, project, mode, priority, status, tags, dates, estimate, links, blocked reason, dependencies, recurrence). Only fields you pass change. Changes are diffed into the history with your note.',
      inputSchema: {
        task: taskKey,
        title: z.string().min(1).optional(),
        ...fieldShape,
        status: StatusSchema.optional(),
        note: z.string().optional().describe('Reason for the change'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    handler(async a => {
      const { task, note, ...fields } = a;
      const t = await tasks.updateTask(task, toPatch(fields), ACTOR, { note });
      return { updated: await brief(t, ctx) };
    }),
  );

  server.registerTool(
    'log_progress',
    {
      title: 'Log progress',
      description:
        'Record a progress update: percent complete plus a note on what moved. Moves Not Started → In Progress automatically. Optionally change status (e.g. Blocked, with the reason in the note).',
      inputSchema: {
        task: taskKey,
        progress: z.number().int().min(0).max(100),
        note: z.string().optional().describe('What changed / what is next'),
        status: StatusSchema.optional(),
        blocked_reason: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    handler(async a => {
      const patch: TaskPatch = { progress: a.progress };
      if (a.status) patch.status = a.status;
      if (a.blocked_reason !== undefined) patch.blockedReason = a.blocked_reason;
      const t = await tasks.updateTask(a.task, patch, ACTOR, { note: a.note, kind: 'progress' });
      return { updated: await brief(t, ctx) };
    }),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Mark a task Done (progress 100). Recurring tasks automatically get their next occurrence created.',
      inputSchema: { task: taskKey, note: z.string().optional().describe('Outcome / what shipped') },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    handler(async a => {
      const t = await tasks.completeTask(a.task, a.note, ACTOR);
      const next = t.nextRef ? await tasks.getTask(t.nextRef) : null;
      return { completed: await brief(t, ctx), ...(next ? { nextOccurrence: await brief(next, ctx) } : {}) };
    }),
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add note',
      description: 'Add a note/comment to a task’s history without changing any fields.',
      inputSchema: { task: taskKey, note: z.string().min(1) },
      annotations: { destructiveHint: false },
    },
    handler(async a => {
      const t = await tasks.addComment(a.task, a.note, ACTOR);
      return { ok: true, task: `#${t.ref} ${t.title}` };
    }),
  );

  server.registerTool(
    'update_checklist',
    {
      title: 'Update checklist',
      description: 'Add, check, uncheck or remove checklist items. Items are matched by number (1-based), id, or text.',
      inputSchema: {
        task: taskKey,
        add: z.array(z.string()).optional(),
        check: z.array(z.union([z.number().int(), z.string()])).optional(),
        uncheck: z.array(z.union([z.number().int(), z.string()])).optional(),
        remove: z.array(z.union([z.number().int(), z.string()])).optional(),
      },
      annotations: { destructiveHint: false },
    },
    handler(async a => {
      const t = await tasks.updateChecklist(a.task, { add: a.add, check: a.check, uncheck: a.uncheck, remove: a.remove }, ACTOR);
      return { ref: t.ref, checklist: t.checklist.map((i, n) => ({ n: n + 1, text: i.text, done: i.done })) };
    }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects/clients with open, overdue, in-progress, blocked and completed counts and a completion percentage.',
      inputSchema: { include_inactive: z.boolean().optional().describe('Include done/archived projects') },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      const list = await projects.listProjects({ includeInactive: a.include_inactive });
      return list.map(p => ({ id: p.id, name: p.name, client: p.client || undefined, status: p.status, ...p.stats, url: `${ctx.baseUrl}/projects/${p.id}` }));
    }),
  );

  server.registerTool(
    'add_project',
    {
      title: 'Add project',
      description: 'Create a project. If one with the same name exists it is returned instead.',
      inputSchema: {
        name: z.string().min(1),
        client: z.string().optional(),
        description: z.string().optional(),
        status: ProjectStatusSchema.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    handler(async a => projects.createProject(a)),
  );

  server.registerTool(
    'update_project',
    {
      title: 'Update project',
      description: 'Rename a project or change its client, description or status (active, paused, done, archived).',
      inputSchema: {
        project: z.string().describe('Project id or name'),
        name: z.string().min(1).optional(),
        client: z.string().optional(),
        description: z.string().optional(),
        status: ProjectStatusSchema.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    handler(async a => {
      const { project, ...patch } = a;
      const p = await projects.getProject(project);
      if (!p) throw new NotFoundError(`Project "${project}" not found`);
      return projects.updateProject(p.id, patch);
    }),
  );

  server.registerTool(
    'daily_summary',
    {
      title: 'Daily summary',
      description:
        'One call for the morning brief: counts plus overdue, due today, in progress, blocked (incl. waiting on dependencies), due in the next 7 days, tasks completed since, all task changes since (with who made them), and per-project open/overdue counts. "since" defaults to the start of the previous workday (Monday → Friday).',
      inputSchema: {
        since: z.string().optional().describe('yesterday | last_workday | 24h | 3d | YYYY-MM-DD | ISO datetime'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => dailySummary({ since: parseSince(a.since), baseUrl: ctx.baseUrl })),
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description: 'History feed across all tasks (status changes, progress, edits, notes, completions), newest first.',
      inputSchema: {
        since: z.string().optional().describe('Default 24h. yesterday | 48h | 7d | YYYY-MM-DD | ISO datetime'),
        actor: z.enum(['me', 'claude', 'system']).optional().describe('me = Om in the app'),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(300).optional().describe('Default 100'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      const since = parseSince(a.since ?? '24h');
      const list = await tasks.listActivity({ since, actor: a.actor, project: a.project, limit: a.limit ?? 100 });
      return {
        since: since?.toISOString(),
        count: list.length,
        events: list.map(e => ({ at: e.at, by: e.actor, task: `#${e.taskRef} ${e.taskTitle}`, type: e.type, text: describeActivity(e) })),
      };
    }),
  );

  return server;
}
