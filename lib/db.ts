import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, type ClientSession, type Db, type Collection } from 'mongodb';
import type { TaskSource, Activity, Actor, ActivityType, FieldChange, ProjectStatus, Mode, Priority, Status, ChecklistItem, Link, Recurrence, WeeklyReview, FiverrRitualLog } from './types';

// ── Document shapes as stored in MongoDB ────────────────────────────────────

export type TaskDoc = {
  _id: string;
  ref: number;
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
};

export type ActivityDoc = {
  _id: string;
  taskId: string;
  taskRef: number;
  taskTitle: string;
  at: Date;
  actor: Actor;
  type: ActivityType;
  changes?: Record<string, FieldChange>;
  note?: string;
};

export type ProjectDoc = {
  _id: string;
  name: string;
  nameLower: string;
  client: string;
  description: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewDoc = Omit<WeeklyReview, 'id'> & { _id: string };
export type RitualDoc = Omit<FiverrRitualLog, 'id'> & { _id: string };
export type CounterDoc = { _id: string; seq: number };
export type NoteDoc = {
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

export type AlertKind = 'due_tomorrow' | 'due_today' | 'overdue' | 'stalled' | 'never_started' | 'unblocked';
/** One row per alert sent (key encodes task + occasion), so each is sent once. */
export type AlertLogDoc = { _id: string; kind: AlertKind; taskId?: string; sentAt: Date };
/** Event alerts waiting for the next send (queued inside the write's transaction). */
export type AlertQueueDoc = { _id: string; kind: 'unblocked'; taskId: string; byTaskId: string; createdAt: Date; sentAt: Date | null };

/** In-app inbox: every alert delivered (plus test notifications). */
export type NotificationDoc = { _id: string; kind: AlertKind | 'test'; title: string; body: string; url: string; createdAt: Date; readAt: Date | null };
/** Web Push subscriptions, keyed by endpoint (one per device/browser). */
export type PushSubDoc = { _id: string; keys: { p256dh: string; auth: string }; device: string; createdAt: Date; updatedAt: Date };

/** A deleted task with its history, kept 30 days so it can be restored. */
export type TrashDoc = {
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
export type SettingsDoc = {
  _id: string;
  blockedIds?: string[];
  updatedAt?: Date;
  /** _id 'alerts': last scheduled run */
  lastRunAt?: Date;
  lastResult?: string;
  /** _id 'security': authenticator-app second factor. `secret` is AES-GCM encrypted (lib/totp.ts). */
  totp?: { secret: string; enabledAt: Date; recoveryHashes: string[]; lastStep: number } | null;
  /** _id 'security': secret shown during setup, until the first code confirms it. */
  totpPending?: { secret: string; createdAt: Date } | null;
};

/** A registered passkey (WebAuthn credential). _id = credential id (base64url). */
export type PasskeyDoc = {
  _id: string;
  publicKey: string; // base64url COSE key
  counter: number;
  transports: string[];
  deviceName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};
/** Outstanding WebAuthn challenge. Deleted when used (single-use); TTL index removes stale ones. */
export type AuthChallengeDoc = { _id: string; kind: 'register' | 'login'; expiresAt: Date; ip?: string };
/** One failed password / 2FA check. TTL index keeps only the last 15 minutes. */
export type AuthFailureDoc = { _id: string; kind: 'password' | 'totp'; at: Date; ip?: string };

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

function getClient(): Promise<MongoClient> {
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

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('tasks').createIndexes([
      { key: { ref: 1 }, unique: true, name: 'ref_unique' },
      { key: { status: 1, due: 1 }, name: 'status_due' },
      { key: { projectId: 1 }, name: 'project' },
      { key: { doneAt: -1 }, name: 'doneAt' },
      { key: { 'source.messageId': 1 }, name: 'source_message', sparse: true },
    ]),
    db.collection('activity').createIndexes([
      { key: { taskId: 1, at: -1 }, name: 'task_at' },
      { key: { at: -1 }, name: 'at' },
    ]),
    db.collection('projects').createIndexes([{ key: { nameLower: 1 }, unique: true, name: 'name_unique' }]),
    db.collection('ritualLogs').createIndexes([{ key: { date: 1 }, unique: true, name: 'date_unique' }]),
    db.collection('alertLog').createIndexes([{ key: { taskId: 1 }, name: 'task' }, { key: { sentAt: 1 }, name: 'sentAt' }]),
    db.collection('alertQueue').createIndexes([{ key: { sentAt: 1 }, name: 'sentAt' }]),
    db.collection('notifications').createIndexes([{ key: { createdAt: -1 }, name: 'created' }, { key: { readAt: 1 }, name: 'read' }]),
    db.collection('notes').createIndexes([
      { key: { taskId: 1, deletedAt: 1 }, name: 'one_live_note_per_task', unique: true, partialFilterExpression: { taskId: { $type: 'string' } } },
      { key: { projectId: 1, updatedAt: -1 }, name: 'project_updated' },
      { key: { updatedAt: -1 }, name: 'updated' },
      { key: { parentId: 1 }, name: 'parent', sparse: true },
    ]),
    db.collection('trash').createIndexes([{ key: { deletedAt: -1 }, name: 'deletedAt' }, { key: { ref: 1 }, name: 'ref' }]),
    db.collection('authChallenges').createIndexes([{ key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 }, { key: { ip: 1, kind: 1 }, name: 'ip_kind' }]),
    db.collection('authFailures').createIndexes([{ key: { at: 1 }, name: 'at_ttl', expireAfterSeconds: 15 * 60 }, { key: { ip: 1, at: -1 }, name: 'ip_at' }]),
  ]);
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
    passkeys: db.collection<PasskeyDoc>('passkeys'),
    authChallenges: db.collection<AuthChallengeDoc>('authChallenges'),
    authFailures: db.collection<AuthFailureDoc>('authFailures'),
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
      result = await txStore.run(session, fn);
    });
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
    actor: d.actor,
    type: d.type,
    ...(d.changes ? { changes: d.changes } : {}),
    ...(d.note ? { note: d.note } : {}),
  };
}
