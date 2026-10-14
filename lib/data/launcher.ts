import 'server-only';
import { randomUUID } from 'node:crypto';
import { collections, type WorkerFolderDoc, type WorkerSessionDoc } from '../db';
import { InputError, NotFoundError } from './errors';
import { normalizeRemote } from './code-locations';

// Session launcher, Work OS side (docs/launcher.md). Workers report folders (names + ids, never
// paths), poll for jobs, and report sessions. Om links folders to projects and starts, resumes
// or stops sessions; each of those is a job for one device.

export const POLL_SECONDS = 10;
const RETAKE_MS = 10 * 60_000;
const MAX_FOLDERS = 3000;
const MAX_PROMPT = 4000;
const FOLDER_ID = /^[A-Za-z0-9_-]{4,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A session not heard of for this long is shown as unknown (worker offline). */
export const STALE_SESSION_MS = 3 * 60_000;

// ── Worker side ─────────────────────────────────────────────────────────────

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
export async function reportFolders(deviceId: string, body: unknown): Promise<{ known: number; missing: number }> {
  const list = (body as { folders?: unknown })?.folders;
  if (!Array.isArray(list)) throw new InputError('folders must be an array');
  if (list.length > MAX_FOLDERS) throw new InputError(`at most ${MAX_FOLDERS} folders`);
  const folders = list.map(cleanFolder);
  const c = await collections();
  const now = new Date();
  if (folders.length) {
    await c.workerFolders.bulkWrite(
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
  }
  const gone = await c.workerFolders.updateMany({ deviceId, seenAt: { $lt: now }, missing: false }, { $set: { missing: true } });
  return { known: folders.length, missing: gone.modifiedCount };
}

export type JobsResponse = {
  enabled: boolean;
  pollSeconds: number;
  links: { folderId: string; projectId: string; projectName: string }[];
  jobs: { id: string; kind: 'start' | 'resume' | 'stop'; folderId?: string; projectId?: string; projectName?: string; sessionId: string; prompt?: string }[];
};

export async function pollJobs(deviceId: string): Promise<JobsResponse> {
  const c = await collections();
  const now = new Date();
  const linked = await c.workerFolders.find({ deviceId, projectId: { $ne: null } }, { projection: { folderId: 1, projectId: 1 } }).toArray();
  const pending = await c.workerJobs
    .find({ deviceId, doneAt: null, $or: [{ takenAt: null }, { takenAt: { $lt: new Date(now.getTime() - RETAKE_MS) } }] })
    .sort({ createdAt: 1 })
    .limit(20)
    .toArray();
  if (pending.length) await c.workerJobs.updateMany({ _id: { $in: pending.map(j => j._id) } }, { $set: { takenAt: now } });
  const pids = [...new Set([...linked.map(l => l.projectId!), ...pending.map(j => j.projectId).filter((x): x is string => !!x)])];
  const names = new Map((await c.projects.find({ _id: { $in: pids } }, { projection: { name: 1 } }).toArray()).map(p => [p._id, p.name]));
  return {
    enabled: true,
    pollSeconds: POLL_SECONDS,
    links: linked.filter(l => names.has(l.projectId!)).map(l => ({ folderId: l.folderId, projectId: l.projectId!, projectName: names.get(l.projectId!)! })),
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

export async function reportStatus(deviceId: string, body: unknown): Promise<void> {
  const b = (body ?? {}) as { worker?: { version?: unknown; os?: unknown }; jobs?: unknown; sessions?: unknown };
  const c = await collections();
  const now = new Date();
  if (b.worker && typeof b.worker === 'object') {
    const version = String(b.worker.version ?? '').slice(0, 20);
    const os = String(b.worker.os ?? '').slice(0, 20);
    await c.devices.updateOne({ _id: deviceId }, { $set: { worker: { version, os }, lastSeenAt: now } });
  }
  if (b.jobs !== undefined && !Array.isArray(b.jobs)) throw new InputError('jobs must be an array');
  for (const r of ((b.jobs as unknown[]) ?? []).slice(0, 50)) {
    const o = (r ?? {}) as { id?: unknown; ok?: unknown; error?: unknown };
    if (typeof o.id !== 'string' || o.id.length > 60) continue;
    const ok = o.ok === true;
    const error = ok ? undefined : String(o.error ?? 'failed').slice(0, 300);
    const job = await c.workerJobs.findOneAndUpdate({ _id: o.id, deviceId, doneAt: null }, { $set: { doneAt: now, ok, ...(error ? { error } : {}) } }, { returnDocument: 'after' });
    if (job && !ok && job.kind !== 'stop') await c.workerSessions.updateOne({ _id: job.sessionId, deviceId }, { $set: { state: 'failed', error, updatedAt: now } });
  }
  if (b.sessions !== undefined && !Array.isArray(b.sessions)) throw new InputError('sessions must be an array');
  for (const s of ((b.sessions as unknown[]) ?? []).slice(0, 100)) {
    const o = (s ?? {}) as { sessionId?: unknown; state?: unknown };
    if (typeof o.sessionId !== 'string' || !UUID.test(o.sessionId)) continue;
    const state = o.state === 'running' || o.state === 'dead' || o.state === 'stopped' ? o.state : null;
    if (!state) continue;
    // Only sessions Work OS created for this device can be updated: a worker can't invent sessions.
    await c.workerSessions.updateOne({ _id: o.sessionId, deviceId }, { $set: { state, updatedAt: now }, $unset: { error: '' } });
  }
}

// ── Om's side ───────────────────────────────────────────────────────────────

export type FolderView = { key: string; deviceId: string; deviceName: string; folderId: string; name: string; remote?: string; branch?: string; missing: boolean; online: boolean };
export type SessionView = { id: string; deviceName: string; folderName: string; state: WorkerSessionDoc['state'] | 'unknown'; startedAt: string; updatedAt: string; error?: string };

const ONLINE_MS = 2 * 60_000;

async function deviceMap() {
  const c = await collections();
  const ds = await c.devices.find({ revokedAt: null }).toArray();
  return new Map(ds.map(d => [d._id, { name: d.name, online: !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < ONLINE_MS }]));
}

function folderView(f: WorkerFolderDoc, devices: Awaited<ReturnType<typeof deviceMap>>): FolderView | null {
  const d = devices.get(f.deviceId);
  if (!d) return null;
  return { key: f._id, deviceId: f.deviceId, deviceName: d.name, folderId: f.folderId, name: f.name, ...(f.remote ? { remote: f.remote } : {}), ...(f.branch ? { branch: f.branch } : {}), missing: f.missing, online: d.online };
}

/** Linked folders, suggested folders (same git remote as one of the project's code locations), and recent sessions. */
export async function projectLauncher(projectId: string): Promise<{ folders: FolderView[]; suggestions: FolderView[]; sessions: SessionView[]; devices: { id: string; name: string }[] }> {
  const c = await collections();
  const devices = await deviceMap();
  if (!devices.size) return { folders: [], suggestions: [], sessions: [], devices: [] };
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  const remotes = [...new Set((p?.code ?? []).map(l => l.remote).filter((r): r is string => !!r))];
  const [linked, sugg, sessions] = await Promise.all([
    c.workerFolders.find({ projectId, deviceId: { $in: [...devices.keys()] } }).sort({ name: 1 }).toArray(),
    remotes.length
      ? c.workerFolders.find({ projectId: null, missing: false, deviceId: { $in: [...devices.keys()] }, remote: { $in: remotes } }).limit(20).toArray()
      : Promise.resolve([]),
    c.workerSessions.find({ projectId }).sort({ updatedAt: -1 }).limit(10).toArray(),
  ]);
  const names = new Map(linked.map(f => [`${f.deviceId}:${f.folderId}`, f.name]));
  return {
    devices: [...devices].map(([id, d]) => ({ id, name: d.name })),
    folders: linked.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x),
    suggestions: sugg.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x),
    sessions: sessions.map(s => ({
      id: s._id,
      deviceName: devices.get(s.deviceId)?.name ?? 'revoked device',
      folderName: names.get(`${s.deviceId}:${s.folderId}`) ?? s.folderId,
      state: (s.state === 'running' || s.state === 'starting') && Date.now() - s.updatedAt.getTime() > STALE_SESSION_MS ? 'unknown' : s.state,
      startedAt: s.startedAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

/** Folders on one device for the "Add folder" picker (unlinked first), filtered by text. */
export async function searchFolders(deviceId: string, q: string): Promise<FolderView[]> {
  const c = await collections();
  const devices = await deviceMap();
  const esc = q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await c.workerFolders
    .find({ deviceId, missing: false, ...(esc ? { name: { $regex: esc, $options: 'i' } } : {}) })
    .sort({ projectId: 1, name: 1 })
    .limit(40)
    .toArray();
  return docs.map(f => folderView(f, devices)).filter((x): x is FolderView => !!x);
}

async function folderDoc(key: string): Promise<WorkerFolderDoc> {
  const f = await (await collections()).workerFolders.findOne({ _id: key });
  if (!f) throw new NotFoundError('Folder not found');
  return f;
}

export async function linkFolder(projectId: string, key: string): Promise<void> {
  const c = await collections();
  if (!(await c.projects.findOne({ _id: projectId }, { projection: { _id: 1 } }))) throw new NotFoundError('Project not found');
  const f = await folderDoc(key);
  if (f.projectId && f.projectId !== projectId) throw new InputError(`"${f.name}" is linked to another project; unlink it there first`);
  await c.workerFolders.updateOne({ _id: key }, { $set: { projectId, linkedAt: new Date() } });
}

export async function unlinkFolder(projectId: string, key: string): Promise<void> {
  const c = await collections();
  await c.workerFolders.updateOne({ _id: key, projectId }, { $set: { projectId: null, linkedAt: null } });
}

async function addJob(deviceId: string, job: { kind: 'start' | 'resume' | 'stop'; sessionId: string; folderId?: string; projectId?: string; prompt?: string }): Promise<void> {
  const c = await collections();
  const open = await c.workerJobs.countDocuments({ deviceId, doneAt: null });
  if (open >= 10) throw new InputError('That device has 10 jobs waiting; is its worker running?');
  await c.workerJobs.insertOne({ _id: `j_${randomUUID()}`, deviceId, ...job, createdAt: new Date(), takenAt: null, doneAt: null });
}

/** Start a new session in a linked folder. prompt: only what Om typed at Start (docs/launcher.md rule 3). */
export async function startSession(projectId: string, key: string, prompt?: string): Promise<string> {
  const f = await folderDoc(key);
  if (f.projectId !== projectId) throw new InputError('That folder is not linked to this project');
  if (f.missing) throw new InputError(`"${f.name}" was not found in the device's last scan`);
  const text = prompt?.trim() ?? '';
  if (text.length > MAX_PROMPT) throw new InputError(`First message is too long (max ${MAX_PROMPT} characters)`);
  const sessionId = randomUUID();
  const c = await collections();
  const now = new Date();
  await c.workerSessions.insertOne({ _id: sessionId, deviceId: f.deviceId, folderId: f.folderId, projectId, state: 'starting', startedAt: now, updatedAt: now });
  await addJob(f.deviceId, { kind: 'start', sessionId, folderId: f.folderId, projectId, ...(text ? { prompt: text } : {}) });
  return sessionId;
}

export async function resumeSession(projectId: string, sessionId: string): Promise<void> {
  const c = await collections();
  const s = await c.workerSessions.findOne({ _id: sessionId, projectId });
  if (!s) throw new NotFoundError('Session not found');
  await c.workerSessions.updateOne({ _id: sessionId }, { $set: { state: 'starting', updatedAt: new Date() }, $unset: { error: '' } });
  await addJob(s.deviceId, { kind: 'resume', sessionId, folderId: s.folderId, projectId });
}

export async function stopSession(projectId: string, sessionId: string): Promise<void> {
  const c = await collections();
  const s = await c.workerSessions.findOne({ _id: sessionId, projectId });
  if (!s) throw new NotFoundError('Session not found');
  await addJob(s.deviceId, { kind: 'stop', sessionId });
}
