import 'server-only';
import type { Document } from 'mongodb';
import { afterCommit, collections, type Collections, type SettingsDoc } from './db';
import { hint, isQuiet, pageUsers, type Topic } from './live';
import { requestContext } from './request-context';

// The one door to the data (docs/multi-user.md, "One door for data"). Every data function takes the caller's scope
// ({ userId, orgId }) and reads and writes through scoped(scope), which adds the organization and the visibility rule
// to every query and stamps them on every insert:
//
//   shared   projects, tasks, notes, Claude items, history, trash: orgId, and visibility 'org' or ownerId = the caller
//   own      the caller's own: devices, folders, jobs, sessions, weekly reviews, ritual logs (ownerId); inbox,
//            push devices, alert log and queue (userId, the recipient)
//   org      counters (one per organization)
//
// orgWide(orgId) is the same door without the visibility rule, for the few processes that must see a whole
// organization: the alert flush (deliver to each recipient), fan-out of "unblocked" alerts to tasks the caller cannot
// see, name uniqueness. Settings are read and written only through the helpers at the end.
//
// Every write through the door also tells the people who can read what changed to refresh (push, lib/live.ts): see
// pushed() below.
//
// tests/scope-check.mjs fails the build if lib/data, lib/mcp, lib/alerts, lib/notify, lib/discord or app/ reach a
// collection any other way (raw access needs a `// scope-ok: <reason>` comment on the same line).

export type Scope = { userId: string; orgId: string };

type Rule = { kind: 'shared' } | { kind: 'own'; field: 'ownerId' | 'userId' } | { kind: 'org' };
const SHARED: Rule = { kind: 'shared' };
const OWNER: Rule = { kind: 'own', field: 'ownerId' };
const RECIPIENT: Rule = { kind: 'own', field: 'userId' };
const ORG: Rule = { kind: 'org' };

const RULES = {
  projects: SHARED,
  tasks: SHARED,
  activity: SHARED,
  notes: SHARED,
  claudeItems: SHARED,
  trash: SHARED,
  reviews: OWNER,
  ritualLogs: OWNER,
  devices: OWNER,
  workerFolders: OWNER,
  workerJobs: OWNER,
  workerSessions: OWNER,
  notifications: RECIPIENT,
  pushSubs: RECIPIENT,
  alertLog: RECIPIENT,
  alertQueue: RECIPIENT,
  counters: ORG,
} satisfies Record<string, Rule>;

export type ScopedName = keyof typeof RULES;
export type ScopedCollections = Pick<Collections, ScopedName>;

/** Thrown for a query the door does not allow (a programming error, never shown to a user). */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

type Mode = { orgId: string; userId: string | null };

function check(s: Scope): Scope {
  if (!s || typeof s.userId !== 'string' || !s.userId || typeof s.orgId !== 'string' || !s.orgId) throw new ScopeError('A data call came without a user and organization');
  return s;
}

/** The query part the door adds for one collection. */
export function scopeFilter(name: ScopedName, m: Mode): Document {
  const rule: Rule = RULES[name];
  if (rule.kind === 'org' || m.userId === null) return { orgId: m.orgId };
  if (rule.kind === 'own') return { orgId: m.orgId, [rule.field]: m.userId };
  return { orgId: m.orgId, $or: [{ visibility: 'org' }, { ownerId: m.userId }] };
}

/** Visibility rule for a document held in memory (the same rule as scopeFilter). */
export function canSee(s: Scope, d: { orgId?: string; ownerId?: string; visibility?: string } | null | undefined): boolean {
  return !!d && d.orgId === s.orgId && (d.visibility === 'org' || d.ownerId === s.userId);
}

const and = (scope: Document, f: unknown): Document => (f && typeof f === 'object' && Object.keys(f as object).length ? { $and: [scope, f] } : scope);

function stamp(name: ScopedName, m: Mode, doc: unknown): Document {
  if (!doc || typeof doc !== 'object') throw new ScopeError(`${name}: insert of a non-document`);
  const d = { ...(doc as Document) };
  if (d.orgId !== undefined && d.orgId !== m.orgId) throw new ScopeError(`${name}: insert into another organization`);
  d.orgId = m.orgId;
  const rule: Rule = RULES[name];
  if (rule.kind === 'own') {
    if (m.userId !== null) {
      if (d[rule.field] !== undefined && d[rule.field] !== m.userId) throw new ScopeError(`${name}: insert for another person (use their scope)`);
      d[rule.field] = m.userId;
    } else if (typeof d[rule.field] !== 'string' || !d[rule.field]) throw new ScopeError(`${name}: insert needs ${rule.field}`);
  } else if (rule.kind === 'shared') {
    if (d.ownerId === undefined && m.userId !== null) d.ownerId = m.userId;
    if (typeof d.ownerId !== 'string' || !d.ownerId) throw new ScopeError(`${name}: insert needs ownerId`);
    if (d.visibility !== 'org' && d.visibility !== 'private') throw new ScopeError(`${name}: insert needs visibility`);
  }
  return d;
}

/** Updates may move a document between people or visibility, never between organizations. */
function guardUpdate(name: ScopedName, update: unknown): void {
  if (Array.isArray(update)) throw new ScopeError(`${name}: pipeline updates are not allowed through the door`);
  const u = (update ?? {}) as Record<string, unknown>;
  for (const op of ['$set', '$unset', '$rename', '$setOnInsert', '$inc', '$push', '$pull', '$addToSet']) {
    const v = u[op] as Record<string, unknown> | undefined;
    if (v && typeof v === 'object' && 'orgId' in v) throw new ScopeError(`${name}: an update cannot change orgId`);
  }
}

function withInsertStamp(name: ScopedName, m: Mode, update: unknown, opts: unknown): unknown {
  // An upsert inserts with the query's equality fields ($and is searched too); orgId always comes from the door.
  if (!(opts as { upsert?: boolean } | undefined)?.upsert) return update;
  const u = { ...(update as Record<string, unknown>) };
  u.$setOnInsert = { ...((u.$setOnInsert as object) ?? {}), orgId: m.orgId };
  const rule: Rule = RULES[name];
  if (rule.kind === 'own' && m.userId !== null) (u.$setOnInsert as Document)[rule.field] = m.userId;
  return u;
}

function scopeLookups(pipeline: unknown, m: Mode, name: string): Document[] {
  if (!Array.isArray(pipeline)) throw new ScopeError(`${name}: aggregate needs a pipeline`);
  return pipeline.map(stage => {
    const st = stage as Document;
    for (const k of ['$unionWith', '$graphLookup', '$out', '$merge', '$facet']) if (k in st) throw new ScopeError(`${name}: ${k} is not allowed through the door`);
    if (!('$lookup' in st)) return st;
    const l = st.$lookup as Document;
    const from = l.from as ScopedName;
    if (!(from in RULES)) throw new ScopeError(`${name}: $lookup into ${String(l.from)} is not allowed`);
    return { $lookup: { ...l, pipeline: [{ $match: scopeFilter(from, m) }, ...scopeLookups(l.pipeline ?? [], m, from)] } };
  });
}

const READS: Record<string, number> = { find: 0, findOne: 0, countDocuments: 0, deleteOne: 0, deleteMany: 0, findOneAndDelete: 0 };

function wrap<C extends object>(name: ScopedName, col: C, m: Mode): C {
  const f = () => scopeFilter(name, m);
  return new Proxy(col, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      const call = (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(target, a);
      if (prop in READS) {
        const read = (filter?: unknown, ...rest: unknown[]) => call(and(f(), filter), ...rest);
        return prop.startsWith('delete') || prop === 'findOneAndDelete' ? pushed(name, m, target, prop, read) : read;
      }
      return pushed(name, m, target, prop, door(prop, call));
    },
  });

  function door(prop: string, call: (...a: unknown[]) => unknown): (...a: never[]) => unknown {
    switch (prop) {
      case 'distinct':
        return (key: string, filter?: unknown, ...rest: unknown[]) => call(key, and(f(), filter), ...rest);
      case 'aggregate':
        return (pipeline: unknown, ...rest: unknown[]) => call([{ $match: f() }, ...scopeLookups(pipeline, m, name)], ...rest);
      case 'updateOne':
      case 'updateMany':
      case 'findOneAndUpdate':
        return (filter: unknown, update: unknown, opts?: unknown) => {
          guardUpdate(name, update);
          return call(and(f(), filter), withInsertStamp(name, m, update, opts), opts);
        };
      case 'replaceOne':
      case 'findOneAndReplace':
        return (filter: unknown, doc: unknown, opts?: unknown) => call(and(f(), filter), stamp(name, m, doc), opts);
      case 'insertOne':
        return (doc: unknown, opts?: unknown) => call(stamp(name, m, doc), opts);
      case 'insertMany':
        return (docs: unknown[], opts?: unknown) => call(docs.map(d => stamp(name, m, d)), opts);
      case 'bulkWrite':
        return (ops: Document[], opts?: unknown) =>
          call(
            ops.map(o => {
              const [kind, body] = Object.entries(o)[0] as [string, Document];
              if (kind === 'insertOne') return { insertOne: { document: stamp(name, m, body.document) } };
              if (kind === 'replaceOne') return { replaceOne: { ...body, filter: and(f(), body.filter), replacement: stamp(name, m, body.replacement) } };
              if (kind === 'updateOne' || kind === 'updateMany') {
                guardUpdate(name, body.update);
                return { [kind]: { ...body, filter: and(f(), body.filter), update: withInsertStamp(name, m, body.update, body) } };
              }
              if (kind === 'deleteOne' || kind === 'deleteMany') return { [kind]: { ...body, filter: and(f(), body.filter) } };
              throw new ScopeError(`${name}: bulkWrite ${kind} is not allowed`);
            }),
            opts,
          );
      default:
        return () => {
          throw new ScopeError(`${name}.${prop} is not available through the door`);
        };
    }
  }
}

// ── Push hints (lib/live.ts) ────────────────────────────────────────────────
// After a write commits, the people who could read what it touched, before or after, get "refresh <topic>". Who that
// is follows the same rules as the filters above: a shared document placed 'org' is everyone in the organization, a
// private one its owner; an own document its owner or recipient. Nothing is sent, and nothing extra is read, while
// nobody in the organization has a page open; when only the writer has, no read either (they can see everything their
// write touched). Otherwise one small read before the write finds the placements it touches.

const TOPICS: Partial<Record<ScopedName, Topic>> = {
  tasks: 'tasks',
  activity: 'tasks',
  trash: 'tasks',
  projects: 'projects',
  notes: 'notes',
  claudeItems: 'claude',
  devices: 'claude',
  workerFolders: 'claude',
  workerJobs: 'claude',
  workerSessions: 'claude',
  notifications: 'inbox',
  reviews: 'review',
  ritualLogs: 'review',
};
const WRITES = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']);
const EVERYONE = '*';

/** Who can read a document placed like d: EVERYONE in the organization, one person, or unknown (null). */
function readerOf(name: ScopedName, d: Document | null | undefined): string | null {
  if (!d) return null;
  const rule: Rule = RULES[name];
  if (rule.kind === 'own') return typeof d[rule.field] === 'string' ? (d[rule.field] as string) : null;
  if (rule.kind === 'shared') return d.visibility === 'org' ? EVERYONE : typeof d.ownerId === 'string' ? (d.ownerId as string) : null;
  return null;
}

/** The filter of the documents a write touches (before it runs), or undefined for a pure insert. */
function touched(prop: string, a: unknown[]): Document | undefined {
  if (prop === 'insertOne' || prop === 'insertMany') return undefined;
  if (prop !== 'bulkWrite') return (a[0] as Document) ?? {};
  const fs = (a[0] as Document[]).flatMap(o => {
    const body = Object.values(o)[0] as Document;
    return body && 'filter' in body ? [body.filter as Document] : [];
  });
  return fs.length ? { $or: fs } : undefined;
}

/** Where inserted, replaced or moved documents end up (the part a read before the write cannot see). */
function placedAfter(prop: string, a: unknown[]): Document[] {
  const fromUpdate = (u: unknown): Document[] => {
    const set = (u as { $set?: Document } | undefined)?.$set;
    return set && ('visibility' in set || 'ownerId' in set || 'userId' in set) ? [set] : [];
  };
  switch (prop) {
    case 'insertOne':
      return [a[0] as Document];
    case 'insertMany':
      return a[0] as Document[];
    case 'replaceOne':
    case 'findOneAndReplace':
      return [a[1] as Document];
    case 'updateOne':
    case 'updateMany':
    case 'findOneAndUpdate':
      return fromUpdate(a[1]);
    case 'bulkWrite':
      return (a[0] as Document[]).flatMap(o => {
        const [kind, body] = Object.entries(o)[0] as [string, Document];
        if (kind === 'insertOne') return [body.document as Document];
        if (kind === 'replaceOne') return [body.replacement as Document];
        return fromUpdate(body.update);
      });
    default:
      return [];
  }
}

/**
 * Does a task write touch what the Claude page shows (a task given to Claude: the `claude` mark)? Then its readers get
 * a 'claude' hint as well as 'tasks'. Other task edits do not refresh open Claude pages (docs/cpu.md "Multi-user":
 * every teammate's edit used to refresh every open Claude page). A delete may remove a marked task, so it counts.
 */
function touchesClaudeMark(prop: string, a: unknown[]): boolean {
  const inDoc = (d: unknown) => !!d && typeof d === 'object' && (d as Document).claude != null;
  const inUpdate = (u: unknown): boolean =>
    Array.isArray(u)
      ? u.some(inUpdate) // an update pipeline: each stage
      : !!u && typeof u === 'object' && Object.values(u as Document).some(v => !!v && typeof v === 'object' && Object.keys(v as Document).some(k => k === 'claude' || k.startsWith('claude.')));
  switch (prop) {
    case 'insertOne':
      return inDoc(a[0]);
    case 'insertMany':
      return (a[0] as unknown[]).some(inDoc);
    case 'replaceOne':
    case 'findOneAndReplace':
      return true; // the old document may have had a mark
    case 'updateOne':
    case 'updateMany':
    case 'findOneAndUpdate':
      return inUpdate(a[1]);
    case 'bulkWrite':
      return (a[0] as Document[]).some(o => {
        const [kind, body] = Object.entries(o)[0] as [string, Document];
        if (kind === 'insertOne') return inDoc(body.document);
        if (kind === 'updateOne' || kind === 'updateMany') return inUpdate(body.update);
        return true;
      });
    default:
      return true; // deletes
  }
}

/** Did the write change anything (no hint for an update that matched nothing)? */
function changed(res: unknown): boolean {
  if (res === null || res === undefined) return false;
  const r = res as Record<string, unknown>;
  if ('ok' in r && 'value' in r && 'lastErrorObject' in r) return r.value !== null; // includeResultMetadata
  const counts = ['modifiedCount', 'upsertedCount', 'deletedCount', 'insertedCount'].filter(k => typeof r[k] === 'number');
  return counts.length ? counts.some(k => (r[k] as number) > 0) : true;
}

/** Wraps a write of the door so that, once it has committed, its readers get a hint. Other calls pass through. */
function pushed(name: ScopedName, m: Mode, target: object, prop: string, base: (...a: never[]) => unknown): (...a: never[]) => unknown {
  const topic = TOPICS[name];
  if (!topic || !WRITES.has(prop)) return base;
  const run = base as (...a: unknown[]) => unknown;
  return async (...a: unknown[]) => {
    if (isQuiet()) return run(...a);
    const viewers = pageUsers(m.orgId);
    if (!viewers.size) return run(...a);
    const rule: Rule = RULES[name];
    const who = new Set<string>();
    const filter = touched(prop, a);
    if (filter !== undefined) {
      if (m.userId !== null && (rule.kind === 'own' || [...viewers].every(u => u === m.userId))) who.add(m.userId);
      else {
        // One read: the distinct placements of the documents this write is about to touch (through the door's filter).
        const col = target as { aggregate: (p: Document[]) => { toArray: () => Promise<Document[]> } };
        const key = rule.kind === 'own' ? `$${rule.field}` : { $cond: [{ $eq: ['$visibility', 'org'] }, EVERYONE, '$ownerId'] };
        // A hint must never fail the write: if this read fails, only the writer is told (never everyone).
        try {
          const rows = await col.aggregate([{ $match: and(scopeFilter(name, m), filter) }, { $group: { _id: key } }, { $limit: 500 }]).toArray();
          for (const r of rows) if (typeof r._id === 'string') who.add(r._id);
        } catch {
          if (m.userId !== null) who.add(m.userId);
        }
      }
    }
    for (const d of placedAfter(prop, a)) {
      const r = readerOf(name, d) ?? (rule.kind !== 'org' ? m.userId : null);
      if (r) who.add(r);
    }
    const res = await run(...a);
    if (who.size && changed(res)) {
      const audience = who.has(EVERYONE) ? EVERYONE : who;
      const writer = requestContext().userId ?? m.userId;
      const alsoClaude = name === 'tasks' && touchesClaudeMark(prop, a);
      afterCommit(() => {
        hint(m.orgId, audience, topic, writer);
        if (alsoClaude) hint(m.orgId, audience, 'claude', writer);
      });
    }
    return res;
  };
}

async function open(m: Mode): Promise<ScopedCollections> {
  const all = await collections();
  return Object.fromEntries((Object.keys(RULES) as ScopedName[]).map(n => [n, wrap(n, all[n], m)])) as ScopedCollections;
}

/** The caller's view: their organization, shared work plus their own private things. */
export function scoped(s: Scope): Promise<ScopedCollections> {
  check(s);
  return open({ orgId: s.orgId, userId: s.userId });
}

/** The whole organization, without the visibility rule. Only for system processes (see the top of this file). */
export function orgWide(orgId: string): Promise<ScopedCollections> {
  if (typeof orgId !== 'string' || !orgId) throw new ScopeError('orgWide needs an organization');
  return open({ orgId, userId: null });
}

/**
 * Is this _id used in any organization? Project ids are slugs of the name and _id is unique across the collection, so
 * a new project's slug must be free everywhere. Answers yes or no only.
 */
export async function idTaken(name: 'projects', id: string): Promise<boolean> {
  return !!(await (await collections())[name].findOne({ _id: id }, { projection: { _id: 1 } }));
}

/** Another person in the same organization (to deliver an alert or inbox notice to them). */
export const forUser = (s: Pick<Scope, 'orgId'>, userId: string): Scope => check({ userId, orgId: s.orgId });

/** Just the scope fields of a caller (so nothing else travels into the data layer). */
export const scopeOf = (c: Scope): Scope => check({ userId: c.userId, orgId: c.orgId });

// ── Settings ────────────────────────────────────────────────────────────────
// One document per person (notify, dispatcher, alerts, status, profile, schedule) or per organization (discord,
// modes), _id `<area>:<id>`.

export type UserArea = 'notify' | 'dispatcher' | 'alerts' | 'status' | 'profile' | 'schedule';
export type OrgArea = 'discord' | 'modes';

async function settingsCol() {
  return (await collections()).settings;
}

export async function getUserSetting(s: Scope, area: UserArea): Promise<SettingsDoc | null> {
  check(s);
  return (await settingsCol()).findOne({ _id: `${area}:${s.userId}`, orgId: s.orgId });
}

export async function setUserSetting(s: Scope, area: UserArea, set: Record<string, unknown>): Promise<void> {
  check(s);
  if ('orgId' in set || 'userId' in set || 'area' in set) throw new ScopeError('settings: owner fields are set by the door');
  await (await settingsCol()).updateOne({ _id: `${area}:${s.userId}` }, { $set: { ...set, area, orgId: s.orgId, userId: s.userId } as Partial<SettingsDoc> }, { upsert: true });
}

export async function getOrgSetting(orgId: string, area: OrgArea): Promise<SettingsDoc | null> {
  return (await settingsCol()).findOne({ _id: `${area}:${orgId}`, orgId });
}

export async function setOrgSetting(orgId: string, area: OrgArea, set: Record<string, unknown>): Promise<void> {
  if ('orgId' in set || 'area' in set) throw new ScopeError('settings: owner fields are set by the door');
  await (await settingsCol()).updateOne({ _id: `${area}:${orgId}` }, { $set: { ...set, area, orgId } as Partial<SettingsDoc> }, { upsert: true });
}

/**
 * Atomically take one person's setting that matches and apply `set` to it (e.g. use up a one-time code): of two
 * concurrent calls only one gets the user id. null if none matches.
 */
export async function takeUserSetting(orgId: string, area: UserArea, match: Document, set: Record<string, unknown>): Promise<string | null> {
  if (typeof orgId !== 'string' || !orgId) throw new ScopeError('takeUserSetting needs an organization');
  if ('orgId' in set || 'userId' in set || 'area' in set) throw new ScopeError('settings: owner fields are set by the door');
  const d = await (await settingsCol()).findOneAndUpdate({ ...match, area, orgId }, { $set: set as Partial<SettingsDoc> }, { projection: { userId: 1 } });
  return d?.userId ?? null;
}

/** People in an organization whose setting matches (e.g. whose dispatcher reads one of these notes). */
export async function usersWithSetting(orgId: string, area: UserArea, match: Document): Promise<string[]> {
  if (typeof orgId !== 'string' || !orgId) throw new ScopeError('usersWithSetting needs an organization');
  const docs = await (await settingsCol()).find({ ...match, area, orgId }, { projection: { userId: 1 } }).toArray();
  return docs.map(d => d.userId).filter((x): x is string => !!x);
}

/**
 * The one organization whose setting matches (the Discord server a command came from belongs to one organization:
 * a unique index on discord guildId). null if none. Answers only which organization.
 */
export async function orgWithSetting(area: OrgArea, match: Document): Promise<string | null> {
  const d = await (await settingsCol()).findOne({ ...match, area, _id: { $regex: `^${area}:` } }, { projection: { orgId: 1 } });
  return d?.orgId ?? null;
}
