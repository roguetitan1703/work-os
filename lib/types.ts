import { z } from 'zod';

export const ModeSchema = z.enum([
  'Code & Dev',
  'Client Delivery',
  'Team Direction',
  'Outreach & Sales',
  'Growth',
  'Research & Planning',
  'Founder Decisions',
  'Business Admin',
]);
export type Mode = z.infer<typeof ModeSchema>;

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done', 'Dropped'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

export const CLOSED_STATUSES: Status[] = ['Done', 'Dropped'];
export const OPEN_STATUSES: Status[] = ['Not Started', 'In Progress', 'Blocked'];

/** Who made a change. `me` = the app UI, `claude` = the MCP connector, `system` = migrations/automation. */
export const ActorSchema = z.enum(['me', 'claude', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

export const ChecklistItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const LinkSchema = z.object({
  url: z.string(),
  label: z.string(),
});
export type Link = z.infer<typeof LinkSchema>;

export const RecurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(365).default(1),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

/** A task as the app sees it (dates serialised as strings so it can cross to client components). */
export type Task = {
  id: string;
  ref: number;
  title: string;
  description: string;
  mode: Mode | null;
  projectId: string | null;
  priority: Priority;
  status: Status;
  tags: string[];
  due: string | null; // YYYY-MM-DD
  start: string | null; // YYYY-MM-DD
  estimateMins: number | null;
  progress: number; // 0–100
  checklist: ChecklistItem[];
  links: Link[];
  blockedReason: string;
  dependsOn: string[]; // task ids
  recurrence: Recurrence | null;
  nextRef: number | null; // set once a recurring task has spawned its next instance
  archived: boolean;
  createdBy: Actor;
  createdAt: string; // ISO datetime
  updatedAt: string;
  doneAt: string | null;
  doneOn: string | null; // YYYY-MM-DD in app timezone
  doneBy: Actor | null;
};

export const ACTIVITY_TYPES = [
  'created',
  'status',
  'completed',
  'reopened',
  'progress',
  'edit',
  'comment',
  'checklist',
  'archived',
  'unarchived',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type FieldChange = { from: unknown; to: unknown };

export type Activity = {
  id: string;
  taskId: string;
  taskRef: number;
  taskTitle: string;
  at: string; // ISO datetime
  actor: Actor;
  type: ActivityType;
  changes?: Record<string, FieldChange>;
  note?: string;
};

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export type Project = {
  id: string; // slug
  name: string;
  client: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

export type ProjectStats = {
  open: number;
  inProgress: number;
  blocked: number;
  overdue: number;
  done: number;
  dropped: number;
  doneThisWeek: number;
  openEstimateMins: number;
  /** done / (done + open), ignoring dropped */
  completion: number;
  lastActivityAt: string | null;
};

export type ProjectWithStats = Project & { stats: ProjectStats };

// ── Inputs (shared by server actions, REST and MCP) ─────────────────────────

const dateInput = z.string().trim().max(40);

export const ChecklistInputSchema = z.union([
  z.string().trim().min(1).max(500),
  z.object({ text: z.string().trim().min(1).max(500), done: z.boolean().optional() }),
]);

export const LinkInputSchema = z.union([
  z.string().trim().min(1).max(2000),
  z.object({ url: z.string().trim().min(1).max(2000), label: z.string().trim().max(200).optional() }),
]);

export const TaskInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  mode: ModeSchema.nullable().optional(),
  project: z.string().trim().max(120).nullable().optional(), // project name or id; created if new
  priority: PrioritySchema.optional(),
  status: StatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  due: dateInput.nullable().optional(),
  start: dateInput.nullable().optional(),
  estimateMins: z.number().int().min(0).max(100_000).nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  checklist: z.array(ChecklistInputSchema).max(100).optional(),
  links: z.array(LinkInputSchema).max(50).optional(),
  blockedReason: z.string().max(2000).optional(),
  dependsOn: z.array(z.union([z.string(), z.number()])).max(50).optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
});
export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskPatchSchema = TaskInputSchema.partial();
export type TaskPatch = z.input<typeof TaskPatchSchema>;

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().max(120).optional(),
  description: z.string().max(5000).optional(),
  status: ProjectStatusSchema.optional(),
});
export type ProjectInput = z.input<typeof ProjectInputSchema>;

// ── Weekly review + Fiverr ritual (unchanged shape) ─────────────────────────

export const WeeklyReviewSchema = z.object({
  id: z.string(),
  weekOf: z.string(),
  shipped: z.string().default(''),
  slipped: z.string().default(''),
  toDrop: z.string().default(''),
  brokenDays: z.number().int().default(0),
  extensionTokensUsed: z.number().int().default(0),
  adjustments: z.string().default(''),
});
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;

export const FiverrRitualLogSchema = z.object({
  id: z.string(),
  date: z.string(), // ISO date YYYY-MM-DD
  bidsPlaced: z.number().int().nonnegative().default(0),
  notes: z.string().optional().default(''),
});
export type FiverrRitualLog = z.infer<typeof FiverrRitualLogSchema>;
