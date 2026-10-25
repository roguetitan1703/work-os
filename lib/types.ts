import { z } from 'zod';
import type { Actor, TextAuthor } from './actors';

/** A mode of work: one of the organization's list (lib/org-modes.ts checks it on every write). */
export const ModeSchema = z.string().trim().max(40);
export type Mode = string;

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done', 'Dropped'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

export const CLOSED_STATUSES: Status[] = ['Done', 'Dropped'];
export const OPEN_STATUSES: Status[] = ['Not Started', 'In Progress', 'Blocked'];

/** Who made a change: lib/actors.ts (a person, an agent acting for a person, Discord, the system). */
export type { Actor, TextAuthor };

/** Who sees a project and everything in it (docs/multi-user.md): the organization, or only its owner. */
export const VISIBILITIES = ['org', 'private'] as const;
export const VisibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const ChecklistItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
});
/** `by`: who wrote the item's text (lib/data/authors.ts); missing on items from before it was stored. */
export type ChecklistItem = z.infer<typeof ChecklistItemSchema> & { by?: TextAuthor };

export const LinkSchema = z.object({
  url: z.string(),
  label: z.string(),
});
/** `by`: who added the link (lib/data/authors.ts); missing on links from before it was stored. */
export type Link = z.infer<typeof LinkSchema> & { by?: TextAuthor };

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
  /** Where the task came from, when created from an external message. */
  source?: TaskSource;
  /** Who wrote the title, description, blocked reason and tags (lib/data/authors.ts); missing before it was stored. */
  titleBy?: TextAuthor;
  descriptionBy?: TextAuthor;
  blockedReasonBy?: TextAuthor;
  tagsBy?: TextAuthor;
  /** Given to Claude (docs/dispatcher.md). Read-only here: only the UI actions and the dispatcher write it. */
  claude?: TaskClaude;
  /** The person it belongs to; with no project (or a private one) only they see it. */
  ownerId: string;
  /** Follows the project: 'org' in a shared project, else 'private'. */
  visibility: Visibility;
  /** A member who does it and gets its alerts (shared tasks only; a private task can be assigned only to its owner). */
  assigneeId: string | null;
};

export const CLAUDE_TASK_STATES = ['queued', 'running', 'finished', 'stopped', 'failed'] as const;
export type ClaudeTaskState = (typeof CLAUDE_TASK_STATES)[number];
export type TaskClaude = {
  state: ClaudeTaskState;
  markedAt: string;
  folderKey?: string;
  sessionId?: string;
  deviceId?: string;
  claimedAt?: string;
  endedAt?: string;
  note?: string;
};

export type TaskSource = {
  kind: 'discord';
  guildId: string;
  channelId: string;
  messageId: string;
  url: string;
  channelName?: string;
  author?: string;
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
  'trashed',
  'restored',
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
  /** Claude Code only: the X-Work-OS-Session / X-Work-OS-Repo headers of the request that made it. */
  session?: string;
  repo?: string;
};

// ── Claude items: Claude Code's own work list per project (never in people's task views) ──

export const CLAUDE_ITEM_KINDS = ['feature', 'bug', 'debt', 'idea'] as const;
export type ClaudeItemKind = (typeof CLAUDE_ITEM_KINDS)[number];
/** dropped: a person only (Claude never removes items). */
export const CLAUDE_ITEM_STATES = ['queued', 'active', 'blocked', 'done', 'dropped'] as const;
export type ClaudeItemState = (typeof CLAUDE_ITEM_STATES)[number];

export type ClaudeItemPart = { id: string; text: string; done: boolean };
export type ClaudeItemLog = { at: string; actor: Actor; session?: string; text: string };
export type ClaudeItemAnswer = { question: string; text: string; by: string; at: string };

export type ClaudeItem = {
  id: string;
  ref: number; // shown as C12
  projectId: string;
  title: string;
  kind: ClaudeItemKind;
  state: ClaudeItemState;
  /** A person's pick: a session takes the top queued item with next on. */
  next: boolean;
  order: number;
  /** What and why, written so a session with no chat history understands it. */
  why: string;
  doneWhen: string;
  note: string;
  /** Small things grouped under one item. */
  parts: ClaudeItemPart[];
  blockedBy: string | null; // another item's id
  /** Blocked on a decision or action from this person (a user id), or null. */
  waitingOn: string | null;
  /** What they must decide or do (empty when not waiting). Was `waitingOnOm`. */
  waitingText: string;
  /** The last question a person answered in the app (text empty: closed without an answer). Sessions read it in get_project. */
  answer?: ClaudeItemAnswer | null;
  gitRef: string; // branch or commit when done
  claimedBy: { session: string; at: string } | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  log: ClaudeItemLog[];
};

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** Where a project's code lives (lib/data/code-locations.ts). remote = lowercase "owner/name". */
export type CodeLocation = { remote?: string; path?: string; subdir?: string; branch?: string };

export const CodeLocationInputSchema = z.object({
  remote: z.string().trim().max(300).optional(),
  path: z.string().trim().max(300).optional(),
  subdir: z.string().trim().max(200).optional(),
  branch: z.string().trim().max(200).optional(),
});

export type Project = {
  id: string; // slug
  name: string;
  ownerId: string;
  visibility: Visibility;
  client: string;
  description: string;
  status: ProjectStatus;
  code?: CodeLocation[];
  /** The member who last named it (created or renamed it); missing on older projects (then its owner). */
  nameBy?: string;
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

// A task link opens in the browser: only web pages and mail. A bare "example.com" gets https:// (lib/data/tasks.ts),
// and any other scheme (javascript:, data:, vbscript:, file: …) is refused here and again where the link is stored.
// "localhost:3000" or "example.com:8080/x" is a host and port, not a scheme; "javascript:1;…" is a scheme (digits
// count as a port only when a path, query or the end follows).
export const LINK_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
/** Whether a link (as typed) may be stored: no scheme, or http(s) or mailto. */
export const linkSchemeAllowed = (url: string) => !LINK_SCHEME.test(url.trim()) || /^(https?:\/\/|mailto:)/i.test(url.trim());
const linkUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(linkSchemeAllowed, 'Not a web address: only http, https and mailto links are kept.');

export const LinkInputSchema = z.union([
  linkUrl,
  z.object({ url: linkUrl, label: z.string().trim().max(200).optional() }),
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
  /** Who does it: a member's user id or email, or 'me'; null clears. Shared tasks only (docs/multi-user.md phase 4). */
  assignee: z.string().trim().min(1).max(200).nullable().optional(),
});
export type TaskInput = z.input<typeof TaskInputSchema>;

export const TaskPatchSchema = TaskInputSchema.partial();
export type TaskPatch = z.input<typeof TaskPatchSchema>;

export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().max(120).optional(),
  description: z.string().max(5000).optional(),
  status: ProjectStatusSchema.optional(),
  /** Replaces the project's code locations; [] or null clears them. */
  code: z.array(CodeLocationInputSchema).max(20).nullable().optional(),
  /** 'private': only its owner sees it and its tasks and notes. Default 'org'. */
  visibility: VisibilitySchema.optional(),
});
export type ProjectInput = z.input<typeof ProjectInputSchema>;

// ── Weekly review + daily routine (the questions and the routine are each person's: lib/schedule.ts) ──

/** Answers by question key (the person's review questions, lib/schedule.ts ReviewField). */
export const ReviewAnswersSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/), z.union([z.string().max(5000), z.number().int().min(0).max(1_000_000)]))
  .refine(a => Object.keys(a).length <= 20, 'Too many answers');

export const WeeklyReviewSchema = z.object({
  id: z.string(),
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  answers: ReviewAnswersSchema.default({}),
});
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;

export const RoutineLogSchema = z.object({
  id: z.string(),
  date: z.string(), // ISO date YYYY-MM-DD
  count: z.number().int().nonnegative().max(100_000).default(0),
  notes: z.string().max(500).optional().default(''),
});
export type RoutineLog = z.infer<typeof RoutineLogSchema>;
