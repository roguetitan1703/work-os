import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import * as tasks from '../data/tasks';
import * as projects from '../data/projects';
import { briefTask, dailySummary } from '../data/summary';
import { applyChanges, MAX_OPS, type BatchOp } from '../data/batch';
import { getProjectTree } from '../data/tree';
import * as notesData from '../data/notes';
import * as items from '../data/claude-items';
import { InputError, NotFoundError } from '../data/errors';
import { CLAUDE_CODE_INSTRUCTIONS, INSTRUCTIONS, TOOLS, type ToolName } from './docs';
import { beforeTool, checkBatch, notifyChanges, PolicyError, watchTarget, watchTasks, type Caller, type WatchTarget } from './policy';
import * as discord from '../discord/read';
import { BlockedChannelError, DiscordError } from '../discord/client';
import { describeActivity } from '../activity-text';
import { addDays, isDateStr, startOfDay, todayStr, weekday } from '../dates';
import { CLAUDE_ITEM_KINDS, ModeSchema, PrioritySchema, ProjectStatusSchema, RecurrenceSchema, StatusSchema, type ClaudeItem, type Task, type TaskPatch } from '../types';

/** caller: who is calling (a Claude chat key → actor "claude"; a Claude Code key → actor "claude-code"; lib/api-keys.ts). */
type Ctx = { baseUrl: string; caller?: Caller };

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
      if (err instanceof InputError || err instanceof NotFoundError || err instanceof DiscordError || err instanceof BlockedChannelError) return fail(err.message);
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
  const note = (await notesData.noteIndex({ taskIds: [t.id] })).byTask.get(t.id) ?? null;
  return {
    ref: t.ref,
    id: t.id,
    url: `${ctx.baseUrl}/tasks/${t.ref}`,
    title: t.title,
    description: t.description,
    note: note ? { ...note, url: `${ctx.baseUrl}/notes/${note.id}` } : null,
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
    activity: d.activity.map(a => ({ id: a.id, at: a.at, by: a.actor, type: a.type, text: describeActivity(a) })),
  };
}

/** A Claude item as MCP output: everything a new session needs, nothing it doesn't. */
function itemOut(i: ClaudeItem, blockers?: items.ProjectItems['blockers']) {
  const b = i.blockedBy ? blockers?.get(i.blockedBy) : undefined;
  return {
    ref: items.itemRef(i.ref),
    title: i.title,
    kind: i.kind,
    state: i.state,
    ...(i.next ? { next: true } : {}),
    why: i.why,
    ...(i.doneWhen ? { doneWhen: i.doneWhen } : {}),
    ...(i.note ? { note: i.note.slice(-1500) } : {}),
    ...(i.parts.length ? { parts: i.parts.map((p, n) => ({ n: n + 1, text: p.text, done: p.done })) } : {}),
    ...(i.blockedBy ? { blockedBy: b ? `${items.itemRef(b.ref)} ${b.title} (${b.state})` : i.blockedBy } : {}),
    ...(i.waitingOnOm ? { waitingOnOm: i.waitingOnOm } : {}),
    ...(i.claimedBy ? { activeIn: `${i.claimedBy.session} since ${i.claimedBy.at}` } : {}),
    ...(i.gitRef ? { landedIn: i.gitRef } : {}),
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

const codeShape = z
  .array(
    z.object({
      remote: z.string().optional().describe('Git remote, any form (https, git@, owner/name); stored as lowercase owner/name'),
      path: z.string().optional().describe('Absolute folder path, for code that is not in a git remote'),
      subdir: z.string().optional().describe('Folder inside the repo (relative to its root) that belongs to this project'),
      branch: z.string().optional().describe('Branch that belongs to this project, e.g. a worktree branch'),
    }),
  )
  .max(20)
  .nullable()
  .optional()
  .describe("Where the project's code lives. Replaces the whole list; [] or null clears it");

export function createMcpServer(ctx: Ctx): McpServer {
  const caller: Caller = ctx.caller ?? { actor: 'claude' };
  const ACTOR = caller.actor;
  const instructions = ACTOR === 'claude-code' ? `${INSTRUCTIONS}\n${CLAUDE_CODE_INSTRUCTIONS}` : INSTRUCTIONS;
  const server = new McpServer({ name: 'work-os', version: '1.0.0' }, { instructions });
  // Title/description come from docs.ts so the /connect page shows exactly what Claude sees.
  // Every tool runs the caller policy first (lib/mcp/policy.ts; a no-op for the claude.ai connector).
  const tool = ((name: ToolName, config: object, cb: (...a: unknown[]) => unknown) =>
    server.registerTool(
      name,
      { ...config, title: TOOLS[name].title, description: TOOLS[name].description },
      (async (...a: unknown[]) => {
        try {
          await beforeTool(caller, name);
        } catch (err) {
          if (err instanceof PolicyError) return fail(err.message);
          console.error('[mcp policy]', err);
          return fail('Internal error');
        }
        return cb(...a);
      }) as never,
    )) as unknown as typeof server.registerTool;

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
      const watch = await watchTasks(caller, [watchTarget('update_task', a)!]);
      const t = await tasks.updateTask(task, toPatch(fields), ACTOR, { note });
      await notifyChanges(watch);
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
      const watch = await watchTasks(caller, [watchTarget('log_progress', a)!]);
      const t = await tasks.logProgress(a.task, a.progress, a.note, ACTOR, a.status, a.blocked_reason);
      await notifyChanges(watch);
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
      const watch = await watchTasks(caller, [watchTarget('complete_task', a)!]);
      const t = await tasks.completeTask(a.task, a.note, ACTOR);
      await notifyChanges(watch);
      const next = t.nextRef ? await tasks.getTask(t.nextRef) : null;
      return { completed: await brief(t, ctx), ...(next ? { nextOccurrence: await brief(next, ctx) } : {}) };
    }),
  );

  tool(
    'add_comment',
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
      const idx = await notesData.noteIndex({ projectIds: list.map(p => p.id) });
      return list.map(p => ({
        id: p.id,
        name: p.name,
        client: p.client || undefined,
        status: p.status,
        ...p.stats,
        notes: idx.byProject.get(p.id)?.map(n => ({ id: n.id, title: n.title })),
        url: `${ctx.baseUrl}/projects/${p.id}`,
      }));
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
        code: codeShape,
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
        code: codeShape,
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
        actor: z.enum(['me', 'discord', 'claude', 'claude-code', 'system']).optional().describe('me = Om in the app, discord = Om via Discord commands, claude = claude.ai, claude-code = Claude Code sessions'),
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

  // ── Batch, nested read, trash ─────────────────────────────────────────────

  const key = z.union([z.number().int(), z.string()]).describe('Ref (12, "#12"), task id, or "$name" from an earlier create_task');
  const item = z.union([z.number().int(), z.string()]);
  const OpSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('create_task'), as: z.string().optional().describe('"$name" to refer to this task in later ops'), title: z.string().min(1), ...fieldShape, status: StatusSchema.optional(), note: z.string().optional() }),
    z.object({ op: z.literal('update_task'), task: key, title: z.string().min(1).optional(), ...fieldShape, status: StatusSchema.optional(), note: z.string().optional() }),
    z.object({ op: z.literal('log_progress'), task: key, progress: z.number().int().min(0).max(100), note: z.string().optional(), status: StatusSchema.optional(), blocked_reason: z.string().optional() }),
    z.object({ op: z.literal('complete_task'), task: key, note: z.string().optional() }),
    z.object({ op: z.literal('add_comment'), task: key, note: z.string().min(1).optional().describe('Same field name as the add_comment tool'), text: z.string().min(1).optional().describe('Older name for note') }),
    z.object({ op: z.literal('edit_comment'), comment_id: z.string().describe('History entry id from get_task'), text: z.string() }),
    z.object({ op: z.literal('delete_comment'), comment_id: z.string() }),
    z.object({ op: z.literal('update_checklist'), task: key, add: z.array(z.string()).optional(), check: z.array(item).optional(), uncheck: z.array(item).optional(), remove: z.array(item).optional() }),
    z.object({ op: z.literal('archive_task'), task: key, archived: z.boolean().optional() }),
    z.object({ op: z.literal('delete_task'), task: key, title: z.string().describe('The task title (or its start), as a safety check'), reason: z.string().optional() }),
    z.object({ op: z.literal('restore_task'), task: key }),
    z.object({
      op: z.literal('write_note'),
      note_id: z.string().optional(),
      task: key.optional(),
      project: z.string().optional(),
      parent_id: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      append: z.string().optional(),
      block_ops: z
        .array(
          z.object({ op: z.enum(['replace', 'insert', 'delete']), block_id: z.string().optional(), after: z.string().optional(), before: z.string().optional(), markdown: z.string().optional() }),
        )
        .optional(),
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).optional(),
      archived: z.boolean().optional(),
    }),
    z.object({ op: z.literal('delete_note'), note_id: z.string(), title: z.string() }),
    z.object({ op: z.literal('add_project'), name: z.string().min(1), client: z.string().optional(), description: z.string().optional(), status: ProjectStatusSchema.optional(), code: codeShape }),
    z.object({ op: z.literal('update_project'), project: z.string(), name: z.string().optional(), client: z.string().optional(), description: z.string().optional(), status: ProjectStatusSchema.optional(), code: codeShape }),
  ]);

  function toBatchOp(o: z.infer<typeof OpSchema>): BatchOp {
    if (o.op === 'create_task') {
      const { op, as, note, title, ...fields } = o;
      return { op, as, note, ...toPatch(fields), title } as BatchOp;
    }
    if (o.op === 'update_task') {
      const { op, task, note, ...fields } = o;
      return { op, task, note, ...toPatch(fields) } as BatchOp;
    }
    if (o.op === 'add_comment') {
      const text = o.note ?? o.text;
      if (!text) throw new InputError('add_comment needs note');
      return { op: 'add_comment', task: o.task, text };
    }
    if (o.op === 'log_progress') {
      const { blocked_reason, ...rest } = o;
      return { ...rest, ...(blocked_reason !== undefined ? { blockedReason: blocked_reason } : {}) };
    }
    return o as BatchOp;
  }

  tool(
    'apply_changes',
    {
      inputSchema: {
        ops: z.array(OpSchema).min(1).max(MAX_OPS),
        dry_run: z.boolean().optional().describe('Run everything, then roll back and report what would happen'),
        confirm: z.string().max(200).optional().describe('Claude Code keys: the confirm token from a dry run of exactly these ops (needed for big changes)'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    handler(async a => {
      const gate = await checkBatch(caller, a.ops, { dryRun: a.dry_run, confirm: a.confirm });
      const watch = a.dry_run
        ? null
        : await watchTasks(
            caller,
            a.ops.flatMap((o): WatchTarget[] => {
              const w = watchTarget(o.op, o as Record<string, unknown>);
              return w ? [w] : [];
            }),
          );
      let r: Awaited<ReturnType<typeof applyChanges>>;
      try {
        r = await applyChanges(a.ops.map(toBatchOp), ACTOR, { dryRun: a.dry_run });
      } catch (err) {
        await gate.release(); // nothing was saved: give back the reserved trash count / confirm token
        throw err;
      }
      if (!r.dryRun) await notifyChanges(watch);
      return {
        ...r,
        ...(r.dryRun
          ? {
              note: gate.confirm
                ? 'Dry run: nothing was saved. To apply, call again with the same ops, without dry_run, and confirm set to the token below (valid 10 minutes).'
                : 'Dry run: nothing was saved. Call again without dry_run to apply.',
              ...(gate.confirm ? { confirm: gate.confirm } : {}),
            }
          : {}),
        results: r.results.map(x => ({ ...x, ...(x.ref ? { url: `${ctx.baseUrl}/tasks/${x.ref}` } : {}) })),
      };
    }),
  );

  tool(
    'get_project',
    {
      inputSchema: {
        project: z.string().optional().describe('Project name or id. Omit it and pass remote (+ subdir, branch) or path to find the project for a repo'),
        remote: z.string().optional().describe('Git remote of the repo you are in (any form, e.g. the output of git remote get-url origin)'),
        subdir: z.string().optional().describe('Your working folder relative to the repo root (git rev-parse --show-prefix)'),
        branch: z.string().optional().describe('Current git branch'),
        path: z.string().optional().describe('Absolute path of your working folder'),
        depth: z.enum(['project', 'tasks', 'full']).optional().describe('Default tasks'),
        include_closed: z.boolean().optional().describe('Also Done/Dropped tasks'),
        activity_per_task: z.number().int().min(1).max(30).optional().describe('depth full: history entries per task (default 5)'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      let projectKey = a.project?.trim();
      let matchedBy: { how: string; location: unknown } | undefined;
      if (!projectKey) {
        if (!a.remote && !a.path) throw new InputError('Give project (name or id), or remote (+ subdir, branch) or path to find it from your repo');
        const m = await projects.findProjectByCode({ remote: a.remote, path: a.path, subdir: a.subdir, branch: a.branch });
        if (!m.matched) {
          return {
            unmatched: true,
            candidates: m.candidates,
            hint: 'No project has this repo as a code location. Ask Om which project this is, then call update_project with code: [{ remote, subdir?, branch? }] (or path) so it resolves next time.',
          };
        }
        projectKey = m.project.id;
        matchedBy = { how: m.how, location: m.location };
      }
      const t = await getProjectTree(projectKey, { depth: a.depth, includeClosed: a.include_closed, activityPerTask: a.activity_per_task });
      const names = await projects.projectNameMap();
      const idx = await notesData.noteIndex({ projectIds: [t.project.id], taskIds: t.tasks?.map(x => x.id) });
      const nref = (n: notesData.NoteRef) => ({ id: n.id, title: n.title, firstLine: n.firstLine, chars: n.chars, updatedAt: n.updatedAt });
      const act = (x: { id: string; at: string; actor: string; type: string; taskRef: number }, text: string) => ({ id: x.id, at: x.at, by: x.actor, type: x.type, ref: x.taskRef, text });
      return {
        project: { id: t.project.id, name: t.project.name, client: t.project.client || undefined, status: t.project.status, description: t.project.description || undefined, code: t.project.code, url: `${ctx.baseUrl}/projects/${t.project.id}`, ...t.project.stats },
        ...(matchedBy ? { matchedBy } : {}),
        notes: (idx.byProject.get(t.project.id) ?? []).map(nref),
        claudeItems: await (async () => {
          const ci = await items.projectItems(t.project.id);
          const open = ci.items.filter(i => i.state === 'queued' || i.state === 'active' || i.state === 'blocked');
          return {
            takeNext: ci.pickNext ? `${items.itemRef(ci.pickNext.ref)} ${ci.pickNext.title}` : null,
            waitingOnOm: ci.waitingOnOm,
            open: open.map(i => itemOut(i, ci.blockers)),
            recentlyDone: ci.items.filter(i => i.state === 'done').map(i => `${items.itemRef(i.ref)} ${i.title}${i.gitRef ? ` (${i.gitRef})` : ''}`),
            doneTotal: ci.doneCount,
          };
        })(),
        recentActivity: t.recentActivity.map(x => act(x, describeActivity(x))),
        ...(t.tasks
          ? {
              tasks: t.tasks.map(x => ({
                ...briefTask(x, names, { baseUrl: ctx.baseUrl }),
                ...(idx.byTask.get(x.id) ? { note: nref(idx.byTask.get(x.id)!) } : {}),
                ...(a.depth === 'full'
                  ? {
                      description: x.description || undefined,
                      checklist: x.checklist.length ? x.checklist.map((i, n) => ({ n: n + 1, text: i.text, done: i.done })) : undefined,
                      waitingOn: x.waitingOn,
                      activity: x.activity?.map(y => act(y, describeActivity(y))),
                    }
                  : x.waitingOn
                    ? { waitingOn: x.waitingOn }
                    : {}),
              })),
            }
          : {}),
        ...(t.closedOmitted ? { closedOmitted: t.closedOmitted } : {}),
      };
    }),
  );

  const itemKey = z.union([z.number().int(), z.string()]).describe('Item ref: "C12" or 12');
  const ItemOpSchema = z.discriminatedUnion('op', [
    z.object({
      op: z.literal('add'),
      project: z.string().describe("The project whose code this changes (not necessarily your folder's project)"),
      title: z.string().max(140).describe('15-140 chars, names the thing itself, e.g. "Bulk bar shows locked records as editable"'),
      kind: z.enum(CLAUDE_ITEM_KINDS),
      why: z.string().max(2000).describe('What is wrong or wanted and where (file, screen, module); readable by a session with no chat history'),
      done_when: z.string().max(1000).optional().describe('How to tell it is finished (required except for ideas)'),
      small: z.boolean().optional().describe('Under ~30 minutes: added as a part of the project\u2019s "Small fixes and checks" item instead of a new item'),
      next: z.boolean().optional().describe('Om\u2019s call: refused for Claude Code keys (Om marks next in the app)'),
      blocked_by: itemKey.optional(),
      waiting_on_om: z.string().max(1000).optional().describe('What Om must decide or do; he gets an inbox notice'),
      note: z.string().max(1000).optional(),
      start: z.boolean().optional().describe('Add it already active in this session'),
    }),
    z.object({ op: z.literal('start'), item: itemKey, take_over: z.boolean().optional().describe('Only if the session holding it has ended') }),
    z.object({ op: z.literal('block'), item: itemKey, blocked_by: itemKey.optional(), waiting_on_om: z.string().max(1000).optional(), reason: z.string().max(1000).optional() }),
    z.object({ op: z.literal('done'), item: itemKey, ref: z.string().max(120).optional().describe('Branch or commit where it landed (required for Claude Code, except ideas)'), note: z.string().optional() }),
    z.object({ op: z.literal('note'), item: itemKey, text: z.string().min(1).max(1000).describe('Decision or context worth keeping; dated automatically') }),
    z.object({ op: z.literal('release'), item: itemKey, reason: z.string().optional().describe('Why it goes back to the queue unfinished') }),
    z.object({ op: z.literal('edit'), item: itemKey, title: z.string().optional(), why: z.string().optional(), done_when: z.string().optional(), kind: z.enum(CLAUDE_ITEM_KINDS).optional() }),
    z.object({
      op: z.literal('parts'),
      item: itemKey,
      add: z.array(z.string().max(300)).max(20).optional(),
      check: z.array(z.union([z.number().int(), z.string()])).optional().describe('Part numbers (1-based) or ids'),
      uncheck: z.array(z.union([z.number().int(), z.string()])).optional(),
    }),
  ]);

  function toItemOp(o: z.infer<typeof ItemOpSchema>): items.ItemOp {
    switch (o.op) {
      case 'add':
        return { op: 'add', project: o.project, title: o.title, kind: o.kind, why: o.why, doneWhen: o.done_when, small: o.small, next: o.next, blockedBy: o.blocked_by, waitingOnOm: o.waiting_on_om, note: o.note, ...(o.start ? { state: 'active' as const } : {}) };
      case 'start':
        return { op: 'start', item: o.item, takeOver: o.take_over };
      case 'block':
        return { op: 'block', item: o.item, blockedBy: o.blocked_by, waitingOnOm: o.waiting_on_om, reason: o.reason };
      case 'done':
        return { op: 'done', item: o.item, gitRef: o.ref, note: o.note };
      case 'edit':
        return { op: 'edit', item: o.item, title: o.title, why: o.why, doneWhen: o.done_when, kind: o.kind };
      default:
        return o;
    }
  }

  tool(
    'update_claude_items',
    {
      inputSchema: {
        session: z.string().max(64).optional().describe('Your branch or worktree name (e.g. "wt/debt-3"): who holds an item you start'),
        ops: z.array(ItemOpSchema).min(1).max(30),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async a => {
      const results = await items.applyItemOps(a.ops.map(toItemOp), { actor: ACTOR, keyId: caller.keyId, session: a.session?.trim() || undefined });
      return { results };
    }),
  );

  tool(
    'delete_task',
    {
      inputSchema: {
        task: taskKey,
        title: z.string().describe('The task title (or its start), as a safety check'),
        reason: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    handler(async a => {
      const watch = await watchTasks(caller, [watchTarget('delete_task', a)!]);
      const r = await tasks.trashTask(a.task, ACTOR, { reason: a.reason, expectTitle: a.title });
      await notifyChanges(watch);
      return { deleted: `#${r.ref} ${r.title}`, restorable: `for ${tasks.TRASH_DAYS} days with restore_task` };
    }),
  );

  tool(
    'restore_task',
    { inputSchema: { task: taskKey }, annotations: { destructiveHint: false } },
    handler(async a => {
      const watch = await watchTasks(caller, [watchTarget('restore_task', a)!]);
      const t = await tasks.restoreTask(a.task, ACTOR);
      await notifyChanges(watch);
      return { restored: await brief(t, ctx) };
    }),
  );

  tool(
    'list_trash',
    { inputSchema: {}, annotations: { readOnlyHint: true } },
    handler(async () => {
      const list = await tasks.listTrash();
      const names = await projects.projectNameMap();
      return list.map(t => ({ ...t, project: t.projectId ? (names.get(t.projectId) ?? null) : null, projectId: undefined }));
    }),
  );

  // ── Notes ───────────────────────────────────────────────────────────────────

  const noteOut = (n: notesData.Note, withBody: boolean) => ({
    id: n.id,
    title: n.title,
    url: `${ctx.baseUrl}/notes/${n.id}`,
    attachedTo: n.taskRef ? `#${n.taskRef} ${n.taskTitle}` : n.parentId ? `sub-page of "${n.parentTitle}" (${n.parentId})` : n.projectName ? `project ${n.projectName}` : null,
    project: n.projectName,
    archived: n.archived || undefined,
    archivedBecause: n.archivedBecause,
    updatedAt: n.updatedAt,
    updatedBy: n.updatedBy,
    chars: n.chars,
    ...(n.subPages.length ? { subPages: n.subPages } : {}),
    ...(withBody ? {} : { firstLine: n.firstLine }),
  });

  const blockOp = z.discriminatedUnion('op', [
    z.object({ op: z.literal('replace'), block_id: z.string(), markdown: z.string() }),
    z.object({ op: z.literal('insert'), after: z.string().optional(), before: z.string().optional(), markdown: z.string().describe('Inserted after/before that block id; at the end if neither') }),
    z.object({ op: z.literal('delete'), block_id: z.string() }),
  ]);

  tool(
    'write_note',
    {
      inputSchema: {
        note_id: z.string().optional().describe('Update this note'),
        task: taskKey.optional().describe("The task's note (created if missing)"),
        project: z.string().optional().describe('Create a NEW project note (only when no existing note fits)'),
        parent_id: z.string().optional().describe('Create a NEW sub-page inside this note'),
        title: z.string().optional(),
        body: z.string().optional().describe('Markdown; replaces the whole page (loses Notion-only formatting). Prefer block_ops'),
        append: z.string().optional().describe('Markdown added at the end'),
        block_ops: z.array(blockOp).optional().describe('Per-block changes using block ids from read_note; untouched blocks keep their formatting'),
        edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).optional().describe('Text replacements; each find must occur exactly once in the page; only that block is rewritten'),
        archived: z.boolean().optional(),
      },
      annotations: { destructiveHint: false },
    },
    handler(async a => {
      const r = await notesData.writeNote(
        { noteId: a.note_id, task: a.task, project: a.project, parentId: a.parent_id, title: a.title, body: a.body, append: a.append, blockOps: a.block_ops, edits: a.edits, archived: a.archived },
        ACTOR,
      );
      return { [r.created ? 'created' : 'updated']: noteOut(r.note, false) };
    }),
  );

  tool(
    'read_note',
    {
      inputSchema: { note_id: z.string().optional(), task: taskKey.optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      if (!a.note_id && a.task === undefined) throw new InputError('Give note_id or task');
      const id = a.note_id ?? (await notesData.getTaskNoteId(a.task!));
      const r = id ? await notesData.getNoteWithBlocks(id, { outline: true }) : null;
      if (!r) throw new NotFoundError(a.note_id ? `Note ${a.note_id} not found` : `Task ${a.task} has no note`);
      return { ...noteOut(r.note, true), markdown: r.note.body, blocks: r.outline };
    }),
  );

  tool(
    'list_notes',
    {
      inputSchema: {
        project: z.string().optional(),
        state: z.enum(['active', 'archived', 'all']).optional().describe('Default active'),
        kind: z.enum(['task', 'project', 'all']).optional(),
        query: z.string().optional().describe('Search titles and text'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async a => {
      const r = await notesData.listNotes({ project: a.project, state: a.state, kind: a.kind, q: a.query, limit: a.limit ?? 50 });
      return { total: r.total, notes: r.notes.map(n => noteOut(n, false)) };
    }),
  );

  tool(
    'delete_note',
    {
      inputSchema: { note_id: z.string(), title: z.string().describe('The note title, as a safety check') },
      annotations: { destructiveHint: true },
    },
    handler(async a => {
      const r = await notesData.deleteNote(a.note_id, ACTOR, { expectTitle: a.title });
      return { deleted: r.title, restorable: `for ${notesData.NOTE_TRASH_DAYS} days` };
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
        ACTOR,
      );
      return { [r.existing ? 'alreadyTracked' : 'created']: await brief(r.task, ctx), message: r.message };
    }),
  );

  return server;
}
