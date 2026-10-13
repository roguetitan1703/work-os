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
};
/** App settings, one doc per area. `discord.blockedIds` = channel/category/thread ids Work OS must never read. */
export type SettingsDoc = { _id: string; blockedIds?: string[]; updatedAt?: Date };

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
    db.collection('trash').createIndexes([{ key: { deletedAt: -1 }, name: 'deletedAt' }, { key: { ref: 1 }, name: 'ref' }]),
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
