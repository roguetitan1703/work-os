import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import * as tasks from '../data/tasks';
import * as projects from '../data/projects';
import { briefTask, dailySummary } from '../data/summary';
import { InputError, NotFoundError } from '../data/errors';
import { INSTRUCTIONS, TOOLS, type ToolName } from './docs';
import * as discord from '../discord/read';
import { DiscordError } from '../discord/client';
import { describeActivity } from '../activity-text';
import { addDays, isDateStr, startOfDay, todayStr, weekday } from '../dates';
import { ModeSchema, PrioritySchema, ProjectStatusSchema, RecurrenceSchema, StatusSchema, type Task, type TaskPatch } from '../types';

const ACTOR = 'claude' as const;


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
      if (err instanceof InputError || err instanceof NotFoundError || err instanceof DiscordError) return fail(err.message);
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
  // Title/description come from docs.ts so the /connect page shows exactly what Claude sees.
  const tool = ((name: ToolName, config: object, cb: unknown) =>
    server.registerTool(name, { ...config, title: TOOLS[name].title, description: TOOLS[name].description }, cb as never)) as unknown as typeof server.registerTool;

  tool(
    'list_tasks',
    {
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

  tool(
    'get_task',
    {
      inputSchema: { task: taskKey, activity_limit: z.number().int().min(1).max(200).optional().describe('Default 20') },
      annotations: { readOnlyHint: true },
    },
    handler(async a => fullTask(a.task, ctx, a.activity_limit)),
  );

  tool(
    'add_task',
    {
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

  tool(
    'update_task',
    {
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

  tool(
    'log_progress',
    {
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

  tool(
    'complete_task',
    {
      inputSchema: { task: taskKey, note: z.string().optional().describe('Outcome / what shipped') },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    handler(async a => {
      const t = await tasks.completeTask(a.task, a.note, ACTOR);
      const next = t.nextRef ? await tasks.getTask(t.nextRef) : null;
      return { completed: await brief(t, ctx), ...(next ? { nextOccurrence: await brief(next, ctx) } : {}) };
    }),
  );

  tool(
    'add_note',
    {
      inputSchema: { task: taskKey, note: z.string().min(1) },
      annotations: { destructiveHint: false },
    },
    handler(async a => {
      const t = await tasks.addComment(a.task, a.note, ACTOR);
      return { ok: true, task: `#${t.ref} ${t.title}` };
    }),
  );

  tool(
    'update_checklist',
    {
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

  tool(
    'list_projects',
    {
      inputSchema: { include_inactive: z.boolean().optional().describe('Include done/archived projects') },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      const list = await projects.listProjects({ includeInactive: a.include_inactive });
      return list.map(p => ({ id: p.id, name: p.name, client: p.client || undefined, status: p.status, ...p.stats, url: `${ctx.baseUrl}/projects/${p.id}` }));
    }),
  );

  tool(
    'add_project',
    {
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

  tool(
    'update_project',
    {
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

  tool(
    'daily_summary',
    {
      inputSchema: {
        since: z.string().optional().describe('yesterday | last_workday | 24h | 3d | YYYY-MM-DD | ISO datetime'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => dailySummary({ since: parseSince(a.since), baseUrl: ctx.baseUrl })),
  );

  tool(
    'recent_activity',
    {
      inputSchema: {
        since: z.string().optional().describe('Default 24h. yesterday | 48h | 7d | YYYY-MM-DD | ISO datetime'),
        actor: z.enum(['me', 'discord', 'claude', 'system']).optional().describe('me = Om in the app, discord = Om via Discord commands'),
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

  // ── Discord (read-only; the bot never posts) ──────────────────────────────

  tool(
    'discord_needs_attention',
    {
      inputSchema: {
        since: z.string().optional().describe('Default: start of previous workday. yesterday | 24h | 3d | YYYY-MM-DD | ISO datetime'),
        max_channels: z.number().int().min(1).max(50).optional().describe('Most-active channels to scan (default 25)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async a => discord.needsAttention({ since: parseSince(a.since), maxChannels: a.max_channels })),
  );

  tool(
    'discord_list_channels',
    {
      inputSchema: {
        active_since: z.string().optional().describe('Only channels/threads with messages since: today | 24h | 3d | YYYY-MM-DD | ISO'),
        include_threads: z.boolean().optional().describe('Default true'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async a => discord.listChannels({ activeSince: parseSince(a.active_since), includeThreads: a.include_threads })),
  );

  tool(
    'discord_read_messages',
    {
      inputSchema: {
        channel: z.string().describe('Channel or thread name (e.g. "dev"), id, or link'),
        since: z.string().optional().describe('today | 24h | 3d | YYYY-MM-DD | ISO; returns up to limit (max 300) newest since then'),
        before: z.string().optional().describe('Message id'),
        after: z.string().optional().describe('Message id'),
        around: z.string().optional().describe('Message id'),
        limit: z.number().int().min(1).max(300).optional().describe('Default 50 (max 100 without since)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async a =>
      discord.readMessages({ channel: a.channel, since: parseSince(a.since), before: a.before, after: a.after, around: a.around, limit: a.limit }),
    ),
  );

  tool(
    'discord_message_to_task',
    {
      inputSchema: {
        message_link: z.string().optional().describe('Discord jump link to the message'),
        channel: z.string().optional().describe('Alternative to message_link: channel name or id'),
        message_id: z.string().optional(),
        title: z.string().optional().describe('Short, verb-first title; drafted from the message if omitted'),
        project: z.string().nullable().optional(),
        mode: ModeSchema.nullable().optional(),
        priority: PrioritySchema.optional(),
        due: dateArg.nullable().optional().describe('Only if the message states a date'),
        note: z.string().optional().describe('Why this became a task; stored in history'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(async a => {
      const r = await discord.messageToTask(
        { link: a.message_link, channel: a.channel, messageId: a.message_id },
        { title: a.title, project: a.project, mode: a.mode, priority: a.priority, due: a.due, note: a.note },
      );
      return { [r.existing ? 'alreadyTracked' : 'created']: await brief(r.task, ctx), message: r.message };
    }),
  );

  return server;
}
