import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { MongoClient, type ClientSession, type Db, type Collection, type IndexDescription } from 'mongodb';
import type { CodeLocation, TaskSource, Activity, Actor, ActivityType, FieldChange, ProjectStatus, Mode, Priority, Status, ChecklistItem, Link, Recurrence, Visibility, WeeklyReview, RoutineLog } from './types';
import { asActor } from './actors';

// ── Ownership (docs/multi-user.md, phase 2) ──
// Every stored document carries orgId. Documents that belong to one person carry ownerId (or userId: the recipient of
// a notification, push device, alert). Shared things carry visibility: a project's, which its tasks, notes, Claude
// items, history and trash entries copy. Queries go through lib/scope.ts, which adds orgId and the visibility rule.
/** Fields of a document that lives in the shared space of an organization (project, task, note, ...). */
export type Placed = { orgId: string; ownerId: string; visibility: Visibility };

// ── Document shapes as stored in MongoDB ────────────────────────────────────

export type TaskDoc = Placed & {
  _id: string;
  ref: number;
  /** Gets the task's alerts (when the task is shared); else the owner does. */
  assigneeId?: string | null;
  title: string;
  description: string;
  mode: Mode | null;
  projectId: string | null;
  priority: Priority;
  status: Status;
  tags: string[];
  due: string | null;
  start: string | null;
  estimateMins: number | null;
  progress: number;
  checklist: ChecklistItem[];
  links: Link[];
  blockedReason: string;
  dependsOn: string[];
  recurrence: Recurrence | null;
  nextRef: number | null;
  archived: boolean;
  createdBy: Actor;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
  doneOn: string | null;
  doneBy: Actor | null;
  source?: TaskSource;
  /** Dispatcher (docs/dispatcher.md). Set only by the UI actions and the dispatcher itself, never by a task write from MCP or Discord. */
  claude?: ClaudeMark | null;
};

/** A task a person gave to Claude. */
export type ClaudeMark = {
  state: 'queued' | 'running' | 'finished' | 'stopped' | 'failed';
  markedAt: Date;
  markedBy: 'user';
  /** The signed-in person who gave it to Claude: only their own computers claim it (docs/auth.md). */
  markedByUserId?: string;
  markedByOrgId?: string;
  /** Which linked folder, when the project has more than one (a workerFolders _id). */
  folderKey?: string;
  sessionId?: string;
  deviceId?: string;
  claimedAt?: Date;
  endedAt?: Date;
  /** Why it stopped or failed. */
  note?: string;
  /** Status to restore on failed / requeue. */
  prevStatus?: Status;
  /** Times the reconciler rolled a claim back (3 is the limit). */
  attempts?: number;
};

export type ActivityDoc = Placed & {
  _id: string;
  taskId: string;
  taskRef: number;
  taskTitle: string;
  at: Date;
  actor: Actor;
  type: ActivityType;
  changes?: Record<string, FieldChange>;
  note?: string;
  /** Claude Code session / repo headers (lib/request-context.ts). */
  session?: string;
  repo?: string;
};

export type ProjectDoc = Placed & {
  _id: string;
  name: string;
  nameLower: string;
  client: string;
  description: string;
  status: ProjectStatus;
  /** Where its code lives: git remotes (owner/name, optional subdir/branch) or folder paths. */
  code?: CodeLocation[];
  createdAt: Date;
  updatedAt: Date;
};

/** Reviews from before phase 3 kept their answers as fields (shipped, slipped, …); lib/data/reviews.ts reads both. */
export type ReviewDoc = Omit<WeeklyReview, 'id' | 'answers'> & { _id: string; orgId: string; ownerId: string; answers?: WeeklyReview['answers'] } & Record<string, unknown>;
/** A day's routine log. `bidsPlaced` is the count's name from before phase 3. */
export type RitualDoc = Omit<RoutineLog, 'id' | 'count'> & { _id: string; orgId: string; ownerId: string; count?: number; bidsPlaced?: number };
/** _id `<name>:<orgId>` (task and Claude item numbers per organization). */
export type CounterDoc = { _id: string; seq: number; orgId: string };
export type ClaudeItemDoc = Placed & Omit<import('./types').ClaudeItem, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'doneAt' | 'claimedBy' | 'log'> & {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
  claimedBy: { session: string; at: Date } | null;
  log: { at: Date; actor: Actor; session?: string; text: string }[];
  /** Claude Code key that created it (for the per-day cap). */
  keyId?: string;
  /** The project's "Small fixes and checks" item (not counted toward the cap; title/kind fixed). */
  group?: true;
};
export type NoteDoc = Placed & {
  _id: string;
  title: string;
  /** Editor blocks (source of truth). Missing on notes written before the block editor; derived from body then. */
  blocks?: unknown[];
  body: string; // markdown, derived from blocks (search, previews, Claude)
  /** Sub-page: the note this page lives in. */
  parentId?: string | null;
  taskId: string | null; // task note (at most one live per task)
  projectId: string | null; // project note (when taskId is null)
  archived: boolean;
  createdBy: Actor;
  createdAt: Date;
  updatedBy: Actor;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy?: Actor;
};

export type AlertKind = 'due_tomorrow' | 'due_today' | 'overdue' | 'stalled' | 'never_started' | 'unblocked' | 'assigned' | 'claude_finished' | 'claude_stopped' | 'claude_stuck';
/** Kinds sent from the alertQueue (event alerts) rather than found by the scheduled check. */
export type QueuedAlertKind = 'unblocked' | 'assigned' | 'claude_finished' | 'claude_stopped';
/** One row per alert sent (key encodes task + occasion), so each is sent once. */
export type AlertLogDoc = { _id: string; orgId: string; /** Who it was sent to. */ userId: string; kind: AlertKind; taskId?: string; sentAt: Date };
/** Event alerts waiting for the next send (queued inside the write's transaction). */
export type AlertQueueDoc = { _id: string; orgId: string; /** Who gets it: the task's recipient, or the person who gave it to Claude. */ userId: string; kind: QueuedAlertKind; taskId: string; byTaskId: string; createdAt: Date; sentAt: Date | null; /** Dispatcher outcomes: the reason; assigned: who assigned it. */ detail?: string };

/** Inbox-only notices that are not scheduled alerts. */
export type NoticeKind = 'claude_code_changes' | 'claude_waiting';
/** Everything with an on/off switch in Settings → Notifications. */
export type NotifyKind = AlertKind | NoticeKind;
/** In-app inbox: every alert delivered (plus test notifications). */
export type NotificationDoc = { _id: string; orgId: string; /** The recipient. */ userId: string; kind: NotifyKind | 'test' | 'security'; title: string; body: string; url: string; createdAt: Date; readAt: Date | null };
/** Web Push subscriptions, keyed by endpoint (one per device/browser). */
export type PushSubDoc = { _id: string; orgId: string; /** The person signed in when this device turned push on. */ userId: string; keys: { p256dh: string; auth: string }; device: string; createdAt: Date; updatedAt: Date };

/** A deleted task with its history, kept 30 days so it can be restored. */
export type TrashDoc = Placed & {
  _id: string; // task id
  ref: number;
  title: string;
  task: TaskDoc;
  activity: ActivityDoc[];
  deletedAt: Date;
  deletedBy: Actor;
  reason: string;
  /** The task's note, soft-deleted alongside it. */
  noteIds?: string[];
};
/** App settings, one doc per area. `discord.blockedIds` = channel/category/thread ids Work OS must never read. */
/**
 * Per-person and per-organization settings (lib/scope.ts): _id `<area>:<userId>` (notify, dispatcher, alerts, status)
 * or `<area>:<orgId>` (discord). The older single docs (_id 'notify', ...) are renamed by scripts/migrate-ownership.mjs.
 * 'indexes' and 'authMigration' stay global.
 */
export type SettingsDoc = {
  _id: string;
  area?: string;
  orgId?: string;
  userId?: string;
  blockedIds?: string[];
  updatedAt?: Date;
  /** _id 'alerts': last scheduled run */
  lastRunAt?: Date;
  lastResult?: string;
  /** _id 'authMigration' (scripts/migrate-auth.mjs): keys and computers from before sign-in by user, to re-create once. */
  oldKeys?: { name: string; prefix: string }[];
  oldDevices?: { name: string; prefix: string }[];
  dismissedAt?: Date | null;
  /** dispatcher:<userId>: the person's switch and limits for the task dispatcher (docs/dispatcher.md). */
  enabled?: boolean;
  maxConcurrent?: number;
  boilerplateNoteId?: string;
  /** notify:<userId>: where this person's alerts go. */
  notify?: { channels?: Partial<Record<'push' | 'discord', boolean>>; kinds?: Partial<Record<NotifyKind, boolean>> };
  /** status:<userId>: when their Claude connector and Discord were last used. */
  lastMcpAt?: Date;
  lastDiscordAt?: Date;
  /** profile:<userId> (lib/profile.ts): timezone, quiet hours, the linked Discord account and a pending link code. */
  timezone?: string;
  quietStart?: number;
  quietEnd?: number;
  discordId?: string | null;
  discordLink?: { hash: string; expiresAt: Date } | null;
  /** discord:<orgId>: the organization's Discord server (set by the operator). */
  guildId?: string | null;
  /** schedule:<userId> (lib/schedule.ts): the person's week, routine, review questions and own help text. */
  schedule?: unknown;
  /** modes:<orgId> (lib/modes.ts): the organization's modes of work. */
  modes?: unknown;
};

// ── Session launcher (docs/launcher.md) ──
/** A machine running the worker. Only the SHA-256 of its key (wkr_…) is stored. */
export type DeviceDoc = { _id: string; name: string; /** The signed-in user who created it, and their organization (docs/auth.md). Missing on devices from before. */ ownerId?: string; orgId?: string; hash: string; prefix: string; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null; worker?: { version: string; os: string; /** The worker passes a first message to Claude (config allowPrompts). The dispatcher needs it. */ allowPrompts?: boolean }; /** Latest counts from the worker (numbers only). `at` is the server's receive time. */ activity?: DeviceActivity; /** Latest named session list from the worker (docs/launcher.md Activity counts). */ claudeSessions?: { at: Date; items: ReportedClaudeSession[] } };
export type ReportedClaudeSession = { sessionId: string; folder: string; title: string; lastActiveAt: Date; subagentsActive: number; startedByWorkOs: boolean; running: boolean };
export type DeviceActivity = { sessions: number; sessionsWorkOs: number; sessionsOther: number; sessionsActive: number; subagents: number; at: Date };
/** A folder a worker reported. _id = deviceId:folderId. Never a path. */
export type WorkerFolderDoc = { _id: string; /** The device's owner and organization. */ orgId: string; ownerId: string; deviceId: string; folderId: string; name: string; git: boolean; remote?: string; branch?: string; projectId: string | null; linkedAt: Date | null; seenAt: Date; missing: boolean };
export type WorkerJobDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; kind: 'start' | 'resume' | 'stop'; folderId?: string; projectId?: string; sessionId: string; prompt?: string; createdAt: Date; takenAt: Date | null; doneAt: Date | null; ok?: boolean; error?: string };
export type WorkerSessionDoc = { _id: string; orgId: string; ownerId: string; deviceId: string; folderId: string; projectId: string | null; state: 'starting' | 'running' | 'dead' | 'stopped' | 'failed'; startedAt: Date; updatedAt: Date; error?: string; /** Its owner removed it from the list; the doc is kept. */ hidden?: boolean; /** Started by the dispatcher for `taskId`. */ dispatched?: boolean; taskId?: string };
/** Policy counters for API keys (rate limit, trash limit). TTL index keeps 2 hours. */
export type PolicyEventDoc = { _id: string; keyId: string; kind: 'call' | 'trash' | 'worker'; at: Date; n?: number };

/** One email sent (for the hourly limits in lib/mail.ts). TTL index keeps 2 hours. */
export type MailLogDoc = { _id: string; kind: 'reset' | 'changed' | 'test' | 'invite'; at: Date; /** Hash of the recipient, for the per-address limit. */ to?: string };
/** Request log (lib/usage.ts, docs/usage-log.md): one doc per UTC hour, _id 'YYYY-MM-DDTHH'; `counts` keys are 'kind|caller|route'. TTL index keeps 35 days. */
export type RequestStatsDoc = { _id: string; at: Date; total: number; counts: Record<string, number> };

// ── Connection (cached across hot reloads and warm serverless invocations) ──

type Cache = { client?: Promise<MongoClient>; indexes?: Promise<void> };
const g = globalThis as unknown as { __workosMongo?: Cache };
const cache: Cache = (g.__workosMongo ??= {});

/** Env var names that look like a Mongo connection string (Vercel integrations may add a prefix). */
export function mongoEnvNames(): string[] {
  return Object.keys(process.env).filter(k => /MONGO/i.test(k)).sort();
}

function mongoUri(): string | undefined {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const key = Object.keys(process.env).find(
    k => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && process.env[k]?.startsWith('mongodb'),
  );
  return key ? process.env[key] : undefined;
}

export function getClient(): Promise<MongoClient> {
  const uri = mongoUri();
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!cache.client) {
    cache.client = new MongoClient(uri, { maxPoolSize: 5, appName: 'work-os' }).connect().catch(err => {
      cache.client = undefined;
      throw err;
    });
  }
  return cache.client;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB || 'workos');
  if (!cache.indexes) {
    cache.indexes = ensureIndexes(db).catch(err => {
      cache.indexes = undefined;
      throw err;
    });
  }
  await cache.indexes;
  return db;
}

/** Every index the app relies on. Changing this list changes INDEX_VERSION by itself. */
const INDEXES: [string, IndexDescription[]][] = [
    ['tasks', [
      { key: { orgId: 1, ref: 1 }, unique: true, name: 'org_ref_unique' },
      { key: { orgId: 1, status: 1, due: 1 }, name: 'org_status_due' },
      { key: { projectId: 1 }, name: 'project' },
      { key: { orgId: 1, ownerId: 1, status: 1 }, name: 'org_owner_status' },
      { key: { doneAt: -1 }, name: 'doneAt' },
      { key: { 'source.messageId': 1 }, name: 'source_message', sparse: true },
      { key: { 'claude.state': 1, 'claude.markedAt': 1 }, name: 'claude_state', sparse: true },
      // "Who waits on this task" (the task page, get_task, unblocked alerts): without it every task page read the whole organization.
      { key: { dependsOn: 1 }, name: 'depends_on' },
    ]],
    ['activity', [
      { key: { taskId: 1, at: -1 }, name: 'task_at' },
      { key: { orgId: 1, at: -1 }, name: 'org_at' },
    ]],
    ['projects', [
      // Names: one per organization among shared projects, one per owner among private ones (docs/multi-user.md).
      { key: { orgId: 1, nameLower: 1 }, unique: true, name: 'org_shared_name_unique', partialFilterExpression: { visibility: 'org' } },
      { key: { orgId: 1, ownerId: 1, nameLower: 1 }, unique: true, name: 'owner_private_name_unique', partialFilterExpression: { visibility: 'private' } },
      // The door's filter (orgId + visibility or owner) on every project read; the partial indexes above cannot serve it.
      { key: { orgId: 1 }, name: 'org' },
    ]],
    ['ritualLogs', [{ key: { orgId: 1, ownerId: 1, date: 1 }, unique: true, name: 'owner_date_unique' }]],
    ['alertLog', [{ key: { taskId: 1 }, name: 'task' }, { key: { sentAt: 1 }, name: 'sentAt' }]],
    ['alertQueue', [{ key: { sentAt: 1 }, name: 'sentAt' }, { key: { orgId: 1, sentAt: 1 }, name: 'org_sentAt' }]],
    ['notifications', [{ key: { userId: 1, createdAt: -1 }, name: 'user_created' }, { key: { userId: 1, readAt: 1 }, name: 'user_read' }, { key: { createdAt: 1 }, name: 'created_at' }]],
    ['pushSubs', [{ key: { userId: 1 }, name: 'user' }]],
    ['notes', [
      { key: { taskId: 1, deletedAt: 1 }, name: 'one_live_note_per_task', unique: true, partialFilterExpression: { taskId: { $type: 'string' } } },
      { key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' },
      { key: { orgId: 1, updatedAt: -1 }, name: 'org_updated' },
      { key: { parentId: 1 }, name: 'parent', sparse: true },
    ]],
    ['trash', [{ key: { deletedAt: -1 }, name: 'deletedAt' }, { key: { orgId: 1, ref: 1 }, name: 'org_ref' }]],
    ['claudeItems', [
      { key: { orgId: 1, ref: 1 }, unique: true, name: 'org_ref_unique' },
      { key: { orgId: 1, waitingOn: 1, state: 1 }, name: 'org_waiting' },
      { key: { projectId: 1, state: 1, order: 1 }, name: 'project_state_order' },
      { key: { blockedBy: 1 }, name: 'blockedBy' },
    ]],
    ['devices', [{ key: { hash: 1 }, unique: true, name: 'hash_unique' }, { key: { orgId: 1, ownerId: 1 }, name: 'org_owner' }]],
    ['workerFolders', [{ key: { deviceId: 1, name: 1 }, name: 'device_name' }, { key: { projectId: 1 }, name: 'project' }, { key: { remote: 1 }, name: 'remote' }]],
    ['workerJobs', [{ key: { deviceId: 1, doneAt: 1, createdAt: 1 }, name: 'device_pending' }, { key: { createdAt: 1 }, name: 'created_ttl', expireAfterSeconds: 30 * 86_400 }]],
    ['workerSessions', [{ key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' }, { key: { deviceId: 1, state: 1 }, name: 'device_state' }]],
    ['policyEvents', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 2 * 3600 }, { key: { keyId: 1, kind: 1, at: -1 }, name: 'key_kind_at' }]],
    ['mailLog', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 2 * 3600 }, { key: { kind: 1, at: -1 }, name: 'kind_at' }, { key: { kind: 1, to: 1, at: -1 }, name: 'kind_to_at' }]],
    ['requestStats', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 35 * 86_400 }]],
    ['authLimits', [{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 3600 }, { key: { key: 1, at: -1 }, name: 'key_at' }]],
    // Better Auth's collections (lib/auth-server.ts): its MongoDB adapter creates no indexes. A session is read by its
    // token whenever the cookie cache runs out (every 2 minutes per person), a member on every role check, an API key on
    // every MCP call.
    ['session', [{ key: { token: 1 }, name: 'token' }, { key: { userId: 1 }, name: 'user' }]],
    ['member', [{ key: { organizationId: 1, userId: 1 }, name: 'org_user' }, { key: { userId: 1, createdAt: 1 }, name: 'user_created' }]],
    ['apikey', [{ key: { key: 1 }, name: 'key' }, { key: { referenceId: 1 }, name: 'reference' }]],
    ['user', [{ key: { email: 1 }, name: 'email' }]],
    ['account', [{ key: { userId: 1 }, name: 'user' }]],
    ['settings', [
      // One Work OS person per Discord account in an organization, and one organization per Discord server.
      { key: { area: 1, orgId: 1, discordId: 1 }, unique: true, name: 'discord_link_unique', partialFilterExpression: { discordId: { $type: 'string' } } },
      { key: { area: 1, guildId: 1 }, unique: true, name: 'discord_guild_unique', partialFilterExpression: { guildId: { $type: 'string' } } },
    ]],
  ];

/**
 * Indexes replaced by the per-organization ones above (phase 2): a global unique ref or name would refuse the second
 * organization's #1, and one name per organization would tell people the names of others' private projects. The app
 * drops them when the index list changes (ensureIndexes).
 */
const OBSOLETE: [string, string][] = [
  ['tasks', 'ref_unique'], ['tasks', 'status_due'], ['claudeItems', 'ref_unique'], ['projects', 'name_unique'], ['projects', 'org_name_unique'], ['ritualLogs', 'date_unique'],
  ['activity', 'at'], ['notes', 'updated'], ['trash', 'ref'], ['notifications', 'created'], ['notifications', 'read'],
];

/** Hash of the index list: stored in settings so cold starts only create indexes when the list changed. */
const INDEX_VERSION = createHash('sha1').update(JSON.stringify([INDEXES, OBSOLETE])).digest('hex').slice(0, 12);

/** Once per process, and not at all when the database already holds this index set (one read instead of ~25 createIndexes). */
async function ensureIndexes(db: Db): Promise<void> {
  const settings = db.collection<{ _id: string; version?: string }>('settings');
  const marker = await settings.findOne({ _id: 'indexes' }, { projection: { version: 1 } });
  if (marker?.version === INDEX_VERSION) return;
  await Promise.all(OBSOLETE.map(([col, name]) => db.collection(col).dropIndex(name).catch(() => {})));
  await Promise.all(INDEXES.map(([name, specs]) => db.collection(name).createIndexes(specs)));
  await settings.updateOne({ _id: 'indexes' }, { $set: { version: INDEX_VERSION, at: new Date() } }, { upsert: true });
}

export async function collections() {
  const db = await getDb();
  const cols = {
    tasks: db.collection<TaskDoc>('tasks'),
    activity: db.collection<ActivityDoc>('activity'),
    projects: db.collection<ProjectDoc>('projects'),
    reviews: db.collection<ReviewDoc>('reviews'),
    ritualLogs: db.collection<RitualDoc>('ritualLogs'),
    counters: db.collection<CounterDoc>('counters'),
    settings: db.collection<SettingsDoc>('settings'),
    trash: db.collection<TrashDoc>('trash'),
    notes: db.collection<NoteDoc>('notes'),
    alertLog: db.collection<AlertLogDoc>('alertLog'),
    alertQueue: db.collection<AlertQueueDoc>('alertQueue'),
    notifications: db.collection<NotificationDoc>('notifications'),
    pushSubs: db.collection<PushSubDoc>('pushSubs'),
    mailLog: db.collection<MailLogDoc>('mailLog'),
    requestStats: db.collection<RequestStatsDoc>('requestStats'),
    policyEvents: db.collection<PolicyEventDoc>('policyEvents'),
    claudeItems: db.collection<ClaudeItemDoc>('claudeItems'),
    devices: db.collection<DeviceDoc>('devices'),
    workerFolders: db.collection<WorkerFolderDoc>('workerFolders'),
    workerJobs: db.collection<WorkerJobDoc>('workerJobs'),
    workerSessions: db.collection<WorkerSessionDoc>('workerSessions'),
  };
  const session = txStore.getStore();
  return session ? (Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, withSession(v, session)])) as typeof cols) : cols;
}

// ── Transactions ────────────────────────────────────────────────────────────
// inTransaction(fn) runs fn with every collections() call bound to one session, so the
// whole batch commits or rolls back together. The data layer needs no session plumbing.

const txStore = new AsyncLocalStorage<ClientSession>();

/** Position of the options argument for collection methods the data layer uses. */
const OPTIONS_ARG: Record<string, number> = {
  find: 1, findOne: 1, countDocuments: 1, aggregate: 1, distinct: 2,
  insertOne: 1, insertMany: 1, updateOne: 2, updateMany: 2, replaceOne: 2,
  deleteOne: 1, deleteMany: 1, bulkWrite: 1, findOneAndUpdate: 2, findOneAndDelete: 1,
};

function withSession<C extends object>(col: C, session: ClientSession): C {
  return new Proxy(col, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      const i = typeof prop === 'string' ? OPTIONS_ARG[prop] : undefined;
      if (i === undefined) return v.bind(target);
      return (...args: unknown[]) => {
        const a = [...args];
        while (a.length < i) a.push(undefined);
        a[i] = { ...((a[i] as object | undefined) ?? {}), session };
        return v.apply(target, a);
      };
    },
  });
}

// Work to do once the transaction has committed (push hints, lib/live.ts): dropped when it aborts or is a dry run.
const afterCommits = new WeakMap<ClientSession, (() => void)[]>();

/** Runs fn now, or, inside inTransaction, once the transaction has committed (never if it rolls back). */
export function afterCommit(fn: () => void): void {
  const session = txStore.getStore();
  const list = session && afterCommits.get(session);
  if (list) list.push(fn);
  else fn();
}

export function inTransactionNow(): boolean {
  return !!txStore.getStore();
}

/** Run fn atomically. dryRun runs everything, then rolls back and returns fn's result. */
export async function inTransaction<T>(fn: () => Promise<T>, opts: { dryRun?: boolean } = {}): Promise<T> {
  if (txStore.getStore()) return fn(); // already inside one
  await getDb();
  const client = await getClient();
  const session = client.startSession();
  try {
    afterCommits.set(session, []);
    if (opts.dryRun) {
      session.startTransaction();
      try {
        return await txStore.run(session, fn);
      } finally {
        await session.abortTransaction().catch(() => {});
      }
    }
    let result!: T;
    await session.withTransaction(async () => {
      afterCommits.set(session, []); // a retried attempt starts over
      result = await txStore.run(session, fn);
    });
    for (const f of afterCommits.get(session) ?? []) {
      try {
        f();
      } catch (e) {
        console.error('[afterCommit]', e);
      }
    }
    return result;
  } finally {
    await session.endSession();
  }
}

export type Collections = Awaited<ReturnType<typeof collections>>;

export async function nextSeq(counters: Collection<CounterDoc>, name: string): Promise<number> {
  const res = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return res!.seq;
}

export function toActivity(d: ActivityDoc): Activity {
  return {
    id: d._id,
    taskId: d.taskId,
    taskRef: d.taskRef,
    taskTitle: d.taskTitle,
    at: d.at.toISOString(),
    actor: asActor(d.actor),
    type: d.type,
    ...(d.changes ? { changes: d.changes } : {}),
    ...(d.note ? { note: d.note } : {}),
    ...(d.session ? { session: d.session } : {}),
    ...(d.repo ? { repo: d.repo } : {}),
  };
}
