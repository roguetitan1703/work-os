import 'server-only';
import { randomUUID } from 'node:crypto';
import type { DeviceActivity, ReportedClaudeSession, WorkerFolderDoc, WorkerJobDoc, WorkerSessionDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { afterCommit } from '../db';
import { quietly, wake, hint, connectedDevice } from '../live';
import { InputError, NotFoundError } from './errors';
import { normalizeRemote } from './code-locations';

// Session launcher, Work OS side (docs/launcher.md). Workers report folders (names + ids, never
// paths), poll for jobs, and report sessions. The person links folders to projects and starts, resumes
// or stops sessions; each of those is a job for one device.

export const POLL_SECONDS = 10; // while something is starting or a job is open
export const IDLE_POLL_SECONDS = 30; // otherwise: the worker polls all day, and every poll is a function call
const RETAKE_MS = 10 * 60_000;
const MAX_FOLDERS = 3000;
const MAX_PROMPT = 4000;
const FOLDER_ID = /^[A-Za-z0-9_-]{4,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A session not heard of for this long is shown as unknown (worker offline). */
export const STALE_SESSION_MS = 3 * 60_000;
/** A session still "starting" after this long is shown as waiting for the person at the terminal. */
export const WAITING_MS = 60_000;

// ── Worker side ─────────────────────────────────────────────────────────────
// The worker routes act for their device's owner (lib/worker-route.ts): `s` is { userId: device owner, orgId }, so
// every read and write here stays inside that person's own folders, jobs and sessions.

export type ReportedFolder = { id: string; name: string; git?: boolean; remote?: string; branch?: string };

function cleanFolder(f: unknown): ReportedFolder {
  const o = (f ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number) => {
    const v = o[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > max) throw new InputError(`folder ${k} must be a string of at most ${max} characters`);
    return v.trim();
  };
  const id = str('id', 40);
  if (!id || !FOLDER_ID.test(id)) throw new InputError('folder id must match [A-Za-z0-9_-]{4,40}');
  const name = str('name', 120);
  if (!name) throw new InputError('folder name is required');
  // A label, not a path: no drive letters, no leading slash or ~, no ..
  if (/^[a-z]:|^[\\/~]|(^|[\\/])\.\.([\\/]|$)/i.test(name)) throw new InputError(`folder name "${name.slice(0, 40)}" looks like a path; send a name relative to the root`);
  const rawRemote = str('remote', 300);
  // Same owner/name form as project code locations; an unreadable remote is dropped, the folder kept.
  const remote = rawRemote ? (normalizeRemote(rawRemote) ?? undefined) : undefined;
  return { id, name: name.replace(/\\/g, '/'), git: o.git === true, ...(remote ? { remote } : {}), ...(str('branch', 120) ? { branch: str('branch', 120) } : {}) };
}

/** Replaces the device's folder list: upserts reported folders, marks the rest missing (never deletes). */
export async function reportFolders(s: Scope, deviceId: string, body: unknown): Promise<{ known: number; missing: number }> {
  const list = (body as { folders?: unknown })?.folders;
  if (!Array.isArray(list)) throw new InputError('folders must be an array');
  if (list.length > MAX_FOLDERS) throw new InputError(`at most ${MAX_FOLDERS} folders`);
  const folders = list.map(cleanFolder);
  const c = await scoped(s);
  const now = new Date();
  // A rescan (every 15 minutes) rewrites every row's seenAt: quiet, with a hint only for new or vanished folders.
  return quietly(async () => {
    let added = 0;
    if (folders.length) {
      const r = await c.workerFolders.bulkWrite(
        folders.map(f => ({
          updateOne: {
            filter: { _id: `${deviceId}:${f.id}` },
            update: {
              $set: { deviceId, folderId: f.id, name: f.name, git: !!f.git, seenAt: now, missing: false, ...(f.remote ? { remote: f.remote } : {}), ...(f.branch ? { branch: f.branch } : {}) },
              $unset: { ...(f.remote ? {} : { remote: '' }), ...(f.branch ? {} : { branch: '' }) },
              $setOnInsert: { projectId: null, linkedAt: null },
            },
            upsert: true,
          },
        })),
      );
      added = r.upsertedCount;
    }
    const gone = await c.workerFolders.updateMany({ deviceId, seenAt: { $lt: now }, missing: false }, { $set: { missing: true } });
    if (added || gone.modifiedCount) afterCommit(() => hint(s.orgId, new Set([s.userId]), 'claude'));
    return { known: folders.length, missing: gone.modifiedCount };
  });
}

export type JobsResponse = {
  enabled: boolean;
  pollSeconds: number;
  links: { folderId: string; projectId: string; projectName: string }[];
  jobs: { id: string; kind: 'start' | 'resume' | 'stop'; folderId?: string; projectId?: string; projectName?: string; sessionId: string; prompt?: string }[];
};

export async function pollJobs(s: Scope, deviceId: string): Promise<JobsResponse> {
  const c = await scoped(s);
  const now = new Date();
  // Idle poll = two reads plus one count: the linked folders with their project names (one query), this computer's
  // unfinished jobs (one query), and, only when there are none, whether a session is still starting.
  const [linkedRows, notDone] = await Promise.all([
    c.workerFolders
      .aggregate<{ folderId: string; projectId: string; p: { name: string }[] }>([
        { $match: { deviceId, projectId: { $ne: null } } },
        { $project: { folderId: 1, projectId: 1 } },
        { $lookup: { from: 'projects', localField: 'projectId', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: 'p' } },
      ])
      .toArray(),
    c.workerJobs.find({ deviceId, doneAt: null }).sort({ createdAt: 1 }).limit(50).toArray(),
  ]);
  const names = new Map<string, string>();
  const linked = linkedRows.filter(l => l.p[0]).map(l => (names.set(l.projectId, l.p[0].name), l));
  // Hand each job out once: the takenAt stamp is a conditional update per job, so two simultaneous polls never both get it.
  const retakeBefore = new Date(now.getTime() - RETAKE_MS);
  const open = { deviceId, doneAt: null, $or: [{ takenAt: null }, { takenAt: { $lt: retakeBefore } }] };
  const pending: WorkerJobDoc[] = [];
  for (const j of notDone.filter(j => !j.takenAt || j.takenAt < retakeBefore).slice(0, 20)) {
    const got = await c.workerJobs.findOneAndUpdate({ _id: j._id, ...open }, { $set: { takenAt: now } }, { returnDocument: 'after' });
    if (got) pending.push(got);
  }
  const extra = [...new Set(pending.map(j => j.projectId).filter((x): x is string => !!x && !names.has(x)))];
  if (extra.length) for (const p of await c.projects.find({ _id: { $in: extra } }, { projection: { name: 1 } }).toArray()) names.set(p._id, p.name);
  const busy = pending.length > 0 || notDone.length > 0 || (await c.workerSessions.countDocuments({ deviceId, state: 'starting' }, { limit: 1 })) > 0;
  return {
    enabled: true,
    pollSeconds: busy ? POLL_SECONDS : IDLE_POLL_SECONDS,
    links: linked.map(l => ({ folderId: l.folderId, projectId: l.projectId, projectName: names.get(l.projectId)! })),
    jobs: pending.map(j => ({
      id: j._id,
      kind: j.kind,
      sessionId: j.sessionId,
      ...(j.folderId ? { folderId: j.folderId } : {}),
      ...(j.projectId ? { projectId: j.projectId, projectName: names.get(j.projectId) ?? j.projectId } : {}),
      ...(j.prompt ? { prompt: j.prompt } : {}),
    })),
  };
}

/** Counts a worker reports each cycle. Small non-negative integers only; anything else is rejected, big values are capped. */
export const ACTIVITY_CAP = 999;
const ACTIVITY_KEYS = ['sessions', 'sessionsWorkOs', 'sessionsOther', 'sessionsActive', 'subagents'] as const;
export function cleanActivity(raw: unknown): Omit<DeviceActivity, 'at'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('activity must be an object');
  const o = raw as Record<string, unknown>;
  const out = {} as Record<(typeof ACTIVITY_KEYS)[number], number>;
  for (const k of ACTIVITY_KEYS) {
    const v = o[k];
    if (v === undefined && k !== 'sessions' && k !== 'subagents') { out[k] = 0; continue; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new InputError(`activity.${k} must be a whole number, 0 or more`);
    out[k] = Math.min(v, ACTIVITY_CAP);
  }
  return out;
}

/** Named session list a worker reports (sending folder names and titles was approved 2026-10-15). Strict: anything off is a 400. */
export const MAX_SESSION_LIST = 50;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cleanClaudeSessions(raw: unknown): ReportedClaudeSession[] {
  if (!Array.isArray(raw)) throw new InputError('claudeSessions must be an array');
  if (raw.length > MAX_SESSION_LIST) throw new InputError(`at most ${MAX_SESSION_LIST} sessions`);
  const seen = new Set<string>();
  return raw.map((x, n) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new InputError(`claudeSessions[${n}] must be an object`);
    const o = x as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || !ANY_UUID.test(o.sessionId)) throw new InputError(`claudeSessions[${n}].sessionId must be a UUID`);
    const sessionId = o.sessionId.toLowerCase();
    if (seen.has(sessionId)) throw new InputError(`claudeSessions[${n}] repeats a session id`);
    seen.add(sessionId);
    if (typeof o.folder !== 'string' || !o.folder.trim() || o.folder.length > 80) throw new InputError(`claudeSessions[${n}].folder must be a name of 1 to 80 characters`);
    // A folder NAME, never a path: no separators, drive letters or ~.
    if (/[\\/]|^[a-z]:|^~|^\.\.?$|[\u0000-\u001f]/i.test(o.folder)) throw new InputError(`claudeSessions[${n}].folder looks like a path; send the folder name only`);
    if (typeof o.title !== 'string' || o.title.length > 500) throw new InputError(`claudeSessions[${n}].title must be a string`);
    const title = o.title.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || o.folder.trim();
    const at = o.lastActiveAt;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > Date.now() + 86_400_000) throw new InputError(`claudeSessions[${n}].lastActiveAt must be a time in ms`);
    const sub = o.subagentsActive;
    if (typeof sub !== 'number' || !Number.isInteger(sub) || sub < 0) throw new InputError(`claudeSessions[${n}].subagentsActive must be a whole number, 0 or more`);
    if (typeof o.startedByWorkOs !== 'boolean' || typeof o.running !== 'boolean') throw new InputError(`claudeSessions[${n}] flags must be true or false`);
    return { sessionId, folder: o.folder.trim(), title, lastActiveAt: new Date(Math.round(at)), subagentsActive: Math.min(sub, 99), startedByWorkOs: o.startedByWorkOs, running: o.running };
  });
}

export async function reportStatus(s: Scope, deviceId: string, body: unknown): Promise<void> {
  const b = (body ?? {}) as { worker?: { version?: unknown; os?: unknown; allowPrompts?: unknown }; jobs?: unknown; sessions?: unknown; activity?: unknown; claudeSessions?: unknown };
  const activity = b.activity === undefined ? null : cleanActivity(b.activity); // validate before any write
  const claudeSessions = b.claudeSessions === undefined ? null : cleanClaudeSessions(b.claudeSessions);
  const c = await scoped(s);
  const now = new Date();
  // A heartbeat writes the same rows every couple of minutes; it pushes a hint to the person's Claude page only when
  // something that page shows has changed (push, lib/live.ts), so its writes run quietly and this decides.
  let shown = false;
  await quietly(async () => {
    const set: Record<string, unknown> = {};
    if (claudeSessions) set.claudeSessions = { at: now, items: claudeSessions };
    if (activity) set.activity = { ...activity, at: now };
    if (b.worker && typeof b.worker === 'object') {
      const version = String(b.worker.version ?? '').slice(0, 20);
      const os = String(b.worker.os ?? '').slice(0, 20);
      // allowPrompts: whether this worker passes a first message on to Claude. The dispatcher only sends tasks to workers that say true.
      set.worker = { version, os, allowPrompts: b.worker.allowPrompts === true };
      set.lastSeenAt = now;
    }
    if (Object.keys(set).length) {
      const before = await c.devices.findOneAndUpdate({ _id: deviceId }, { $set: set }, { returnDocument: 'before', projection: { activity: 1, claudeSessions: 1, worker: 1 } });
      shown = !before || deviceViewChanged(before, set, now.getTime());
    }
    if (b.jobs !== undefined && !Array.isArray(b.jobs)) throw new InputError('jobs must be an array');
    for (const r of ((b.jobs as unknown[]) ?? []).slice(0, 50)) {
      const o = (r ?? {}) as { id?: unknown; ok?: unknown; error?: unknown };
      if (typeof o.id !== 'string' || o.id.length > 60) continue;
      const ok = o.ok === true;
      const error = ok ? undefined : String(o.error ?? 'failed').slice(0, 300);
      const job = await c.workerJobs.findOneAndUpdate({ _id: o.id, deviceId, doneAt: null }, { $set: { doneAt: now, ok, ...(error ? { error } : {}) } }, { returnDocument: 'after' });
      if (job) shown = true;
      if (job && !ok && job.kind !== 'stop') await c.workerSessions.updateOne({ _id: job.sessionId, deviceId }, { $set: { state: 'failed', error, updatedAt: now } });
      // Stop on a session the worker doesn't know or that isn't running: nothing is left to stop, so don't leave it "running" forever.
      if (job && !ok && job.kind === 'stop' && (error === 'unknown session' || error === 'session not running'))
        await c.workerSessions.updateOne({ _id: job.sessionId, deviceId, state: { $in: ['starting', 'running'] } }, { $set: { state: 'stopped', updatedAt: now }, $unset: { error: '' } });
    }
    if (b.sessions !== undefined && !Array.isArray(b.sessions)) throw new InputError('sessions must be an array');
    for (const x of ((b.sessions as unknown[]) ?? []).slice(0, 100)) {
      const o = (x ?? {}) as { sessionId?: unknown; state?: unknown };
      if (typeof o.sessionId !== 'string' || !UUID.test(o.sessionId)) continue;
      const state = o.state === 'running' || o.state === 'dead' || o.state === 'stopped' ? o.state : null;
      if (!state) continue;
      // Only sessions Work OS created for this device can be updated: a worker can't invent sessions.
      // Only live sessions move on a report, so a late or repeated report never revives a stopped, closed
      // or failed session ("running" after "closed"). Resume sets "starting" first, which allows running again.
      const from = state === 'stopped' ? ['starting', 'running', 'dead'] : ['starting', 'running'];
      const was = await c.workerSessions.findOneAndUpdate({ _id: o.sessionId, deviceId, state: { $in: from as WorkerSessionDoc['state'][] } }, { $set: { state, updatedAt: now }, $unset: { error: '' } }, { returnDocument: 'before', projection: { state: 1 } });
      if (was && was.state !== state) shown = true;
    }
  });
  if (shown) afterCommit(() => hint(s.orgId, new Set([s.userId]), 'claude'));
}

/** What the Claude page shows of a computer's report: counts, and each session's name, flags and working/open/idle. */
function deviceView(d: { activity?: unknown; claudeSessions?: unknown; worker?: unknown }, nowMs: number): string {
  const a = d.activity as DeviceActivity | undefined;
  const items = (d.claudeSessions as { items?: ReportedClaudeSession[] } | undefined)?.items ?? [];
  const bucket = (it: ReportedClaudeSession) => {
    const quiet = nowMs - new Date(it.lastActiveAt).getTime();
    return !it.running ? 'closed' : it.subagentsActive > 0 || quiet <= 2 * 60_000 ? 'working' : quiet > 15 * 60_000 ? 'idle' : 'open';
  };
  return JSON.stringify([
    a ? [a.sessions, a.sessionsWorkOs, a.sessionsOther, a.sessionsActive, a.subagents] : null,
    items.map(it => [it.sessionId, it.folder, it.title, it.startedByWorkOs, it.subagentsActive > 0, bucket(it)]),
    d.worker ?? null,
  ]);
}

/** Did a report change what the page shows? Parts the report did not send count as unchanged. */
function deviceViewChanged(before: { activity?: unknown; claudeSessions?: unknown; worker?: unknown }, set: Record<string, unknown>, nowMs: number): boolean {
  const after = { activity: set.activity ?? before.activity, claudeSessions: set.claudeSessions ?? before.claudeSessions, worker: set.worker ?? before.worker };
  return deviceView(before, nowMs) !== deviceView(after, nowMs);
}

// ── The person's side ───────────────────────────────────────────────────────────────

export type FolderView = { key: string; /** Project it is linked to, if any. */ projectId: string | null; deviceId: string; deviceName: string; folderId: string; name: string; remote?: string; branch?: string; missing: boolean; online: boolean };
export type SessionView = { id: string; deviceName: string; folderName: string; state: WorkerSessionDoc['state'] | 'unknown'; startedAt: string; updatedAt: string; error?: string; /** Folder is still linked to this project. Resume only makes sense then. */ linked: boolean; /** Still "starting" after WAITING_MS: probably sitting at a prompt in the terminal. */ waiting: boolean };

const ONLINE_MS = 2 * 60_000;

/**
 * Whose computers (docs/multi-user.md: computers and agent sessions are private to their owner). Every launcher,
 * dispatcher and overview path driven by a signed-in person works only with devices where ownerId and orgId match;
 * another person's device, folder or session answers "not found". The worker routes act for their own device.
 */
export type DeviceScope = Scope;

/** The person's non-revoked computers. */
export async function deviceMap(scope: DeviceScope) {
  const c = await scoped(scope);
  const ds = await c.devices.find({ revokedAt: null }).toArray();
  // Online: heard from in the last 2 minutes, or its worker holds a push stream now (it then polls only every 5 minutes).
  return new Map(ds.map(d => [d._id, { name: d.name, online: (!!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < ONLINE_MS) || connectedDevice(d._id) }]));
}

/** Every device of the person, revoked ones too (their sessions stay in the history lists). */
export async function ownedDeviceIds(scope: DeviceScope): Promise<string[]> {
  const ds = await (await scoped(scope)).devices.find({}, { projection: { _id: 1 } }).toArray();
  return ds.map(d => d._id);
}

function folderView(f: WorkerFolderDoc, devices: Awaited<ReturnType<typeof deviceMap>>): FolderView | null {
  const d = devices.get(f.deviceId);
  if (!d) return null;
  return { key: f._id, projectId: f.projectId ?? null, deviceId: f.deviceId, deviceName: d.name, folderId: f.folderId, name: f.name, ...(f.remote ? { remote: f.remote } : {}), ...(f.branch ? { branch: f.branch } : {}), missing: f.missing, online: d.online };
}

export const derivedState = (s: WorkerSessionDoc): SessionView['state'] => ((s.state === 'running' || s.state === 'starting') && Date.now() - s.updatedAt.getTime() > STALE_SESSION_MS ? 'unknown' : s.state);

/** Linked folders, suggested folders (same git remote as one of the project's code locations), and recent sessions. */
export async function projectLauncher(scope: DeviceScope, projectId: string): Promise<{ folders: FolderView[]; suggestions: FolderView[]; sessions: SessionView[]; devices: { id: string; name: string }[] }> {
  const c = await scoped(scope);
  const [devices, mine] = await Promise.all([deviceMap(scope), ownedDeviceIds(scope)]);
  if (!devices.size) return { folders: [], suggestions: [], sessions: [], devices: [] };
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  const remotes = [...new Set((p?.code ?? []).map(l => l.remote).filter((r): r is string => !!r))];
  const [linked, sugg, sessions] = await Promise.all([
    c.workerFolders.find({ projectId, deviceId: { $in: [...devices.keys()] } }).sort({ name: 1 }).toArray(),
    remotes.length
      ? c.workerFolders.find({ projectId: null, missing: false, deviceId: { $in: [...devices.keys()] }, remote: { $in: remotes } }).limit(20).toArray()
      : Promise.resolve([]),
    c.workerSessions.find({ projectId, deviceId: { $in: mine }, hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(10).toArray(),
  ]);
  const names = new Map(linked.map(f => [`${f.deviceId}:${f.folderId}`, f.name]));
  return {
    devices: [...devices].map(([id, d]) => ({ id, name: d.name })),
    folders: linked.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x),
    suggestions: sugg.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x),
    sessions: sessions.map(s => ({
      id: s._id,
      linked: names.has(`${s.deviceId}:${s.folderId}`),
      waiting: s.state === 'starting' && Date.now() - s.updatedAt.getTime() > WAITING_MS,
      deviceName: devices.get(s.deviceId)?.name ?? 'revoked device',
      folderName: names.get(`${s.deviceId}:${s.folderId}`) ?? s.folderId,
      state: derivedState(s),
      startedAt: s.startedAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

/** Folders on one device for the "Add folder" picker (unlinked first), filtered by text. */
export async function searchFolders(scope: DeviceScope, deviceId: string, q: string): Promise<FolderView[]> {
  const c = await scoped(scope);
  const devices = await deviceMap(scope);
  if (!devices.has(deviceId)) throw new NotFoundError('Device not found');
  const esc = q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await c.workerFolders
    .find({ deviceId, missing: false, ...(esc ? { name: { $regex: esc, $options: 'i' } } : {}) })
    .sort({ projectId: 1, name: 1 })
    .limit(40)
    .toArray();
  return docs.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x);
}

/** A folder on one of the person's computers; anyone else's is "not found". */
async function folderDoc(scope: DeviceScope, key: string): Promise<WorkerFolderDoc> {
  const c = await scoped(scope);
  const f = await c.workerFolders.findOne({ _id: key });
  if (!f || !(await c.devices.findOne({ _id: f.deviceId }, { projection: { _id: 1 } }))) throw new NotFoundError('Folder not found');
  return f;
}

/** A session of this project on one of the person's computers (revoked ones included); anyone else's is "not found". */
async function sessionDoc(scope: DeviceScope, projectId: string, sessionId: string): Promise<WorkerSessionDoc> {
  const c = await scoped(scope);
  const s = await c.workerSessions.findOne({ _id: sessionId, projectId });
  if (!s || !(await c.devices.findOne({ _id: s.deviceId }, { projection: { _id: 1 } }))) throw new NotFoundError('Session not found');
  return s;
}

export async function linkFolder(scope: DeviceScope, projectId: string, key: string): Promise<void> {
  const c = await scoped(scope);
  if (!(await c.projects.findOne({ _id: projectId }, { projection: { _id: 1 } }))) throw new NotFoundError('Project not found');
  const f = await folderDoc(scope, key);
  if (f.projectId && f.projectId !== projectId) throw new InputError(`"${f.name}" is linked to another project; unlink it there first`);
  await c.workerFolders.updateOne({ _id: key }, { $set: { projectId, linkedAt: new Date() } });
  afterCommit(() => wake(scope.orgId, scope.userId, f.deviceId)); // its worker writes the folder's marker
}

export async function unlinkFolder(scope: DeviceScope, projectId: string, key: string): Promise<void> {
  const c = await scoped(scope);
  const f = await folderDoc(scope, key);
  await c.workerFolders.updateOne({ _id: key, projectId }, { $set: { projectId: null, linkedAt: null } });
  afterCommit(() => wake(scope.orgId, scope.userId, f.deviceId));
}

async function addJob(scope: DeviceScope, deviceId: string, job: { kind: 'start' | 'resume' | 'stop'; sessionId: string; folderId?: string; projectId?: string; prompt?: string }): Promise<void> {
  const c = await scoped(scope);
  if (!(await c.devices.findOne({ _id: deviceId, revokedAt: null }, { projection: { _id: 1 } }))) throw new InputError('That device was revoked; add it again under Claude › Setup');
  const open = await c.workerJobs.countDocuments({ deviceId, doneAt: null });
  if (open >= 10) throw new InputError('That device has 10 jobs waiting; is its worker running?');
  await c.workerJobs.insertOne({ _id: `j_${randomUUID()}`, orgId: scope.orgId, ownerId: scope.userId, deviceId, ...job, createdAt: new Date(), takenAt: null, doneAt: null });
  afterCommit(() => wake(scope.orgId, scope.userId, deviceId)); // push: the worker fetches it now, not at its next poll
}

/** Start a new session in a linked folder. prompt: only what the person typed at Start (docs/launcher.md rule 3). */
export async function startSession(scope: DeviceScope, projectId: string, key: string, prompt?: string): Promise<string> {
  const f = await folderDoc(scope, key);
  if (f.projectId !== projectId) throw new InputError('That folder is not linked to this project');
  if (f.missing) throw new InputError(`"${f.name}" was not found in the device's last scan`);
  return createStartJob(scope, f, projectId, prompt?.trim() ?? '');
}

/**
 * The session row and the start job. Also used by the dispatcher (docs/dispatcher.md), which passes `dispatched`
 * (the fixed template is the prompt, never task text) and a session id it already recorded on the task.
 */
export async function createStartJob(scope: DeviceScope, f: WorkerFolderDoc, projectId: string, text: string, dispatched?: { taskId: string; sessionId: string }): Promise<string> {
  if (text.length > MAX_PROMPT) throw new InputError(`First message is too long (max ${MAX_PROMPT} characters)`);
  const sessionId = dispatched?.sessionId ?? randomUUID();
  const c = await scoped(scope);
  const now = new Date();
  await c.workerSessions.insertOne({ _id: sessionId, orgId: scope.orgId, ownerId: scope.userId, deviceId: f.deviceId, folderId: f.folderId, projectId, state: 'starting', startedAt: now, updatedAt: now, ...(dispatched ? { dispatched: true, taskId: dispatched.taskId } : {}) });
  try {
    await addJob(scope, f.deviceId, { kind: 'start', sessionId, folderId: f.folderId, projectId, ...(text ? { prompt: text } : {}) });
  } catch (err) {
    await c.workerSessions.deleteOne({ _id: sessionId }); // no orphan "starting" row when the job is refused
    throw err;
  }
  return sessionId;
}

export async function resumeSession(scope: DeviceScope, projectId: string, sessionId: string): Promise<void> {
  const c = await scoped(scope);
  const s = await sessionDoc(scope, projectId, sessionId);
  if (!(await c.workerFolders.findOne({ deviceId: s.deviceId, folderId: s.folderId, projectId }, { projection: { _id: 1 } }))) throw new InputError('That folder is no longer linked to this project; link it again first');
  await addJob(scope, s.deviceId, { kind: 'resume', sessionId, folderId: s.folderId, projectId });
  await c.workerSessions.updateOne({ _id: sessionId }, { $set: { state: 'starting', updatedAt: new Date() }, $unset: { error: '' } });
}

export async function stopSession(scope: DeviceScope, projectId: string, sessionId: string): Promise<void> {
  const s = await sessionDoc(scope, projectId, sessionId);
  await addJob(scope, s.deviceId, { kind: 'stop', sessionId });
}

/** Hide a finished session from the list. The doc stays (history); only stopped, failed, dead or silent ones. */
export async function removeSession(scope: DeviceScope, projectId: string, sessionId: string): Promise<void> {
  const c = await scoped(scope);
  const s = await sessionDoc(scope, projectId, sessionId);
  const st = derivedState(s);
  if (st === 'starting' || st === 'running') throw new InputError('Stop it first, then remove it');
  await c.workerSessions.updateOne({ _id: sessionId, projectId }, { $set: { hidden: true } });
}

/** Undo for removeSession: show the session in the list again. */
export async function unhideSession(scope: DeviceScope, projectId: string, sessionId: string): Promise<void> {
  const c = await scoped(scope);
  await sessionDoc(scope, projectId, sessionId);
  const r = await c.workerSessions.updateOne({ _id: sessionId, projectId }, { $unset: { hidden: '' } });
  if (!r.matchedCount) throw new NotFoundError('Session not found');
}
