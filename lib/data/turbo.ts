import 'server-only';
import { randomUUID } from 'node:crypto';
import type { DeviceDoc, WorkerFolderDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { InputError, NotFoundError } from './errors';
import { cloneSpec } from './code-locations';
import { addJob, deviceMap, linkFolder, startSession, type FolderView } from './launcher';

// Turbo mode (docs/launcher.md "Turbo mode"): Start Claude on a project whose repo is not on the person's computer yet makes the
// computer's worker clone it (folder, clone, link, trust) and then start Claude there. The repo comes from the project's code
// locations (Info › Code). This file decides who may do it and what to send; the git work is worker/clone.mjs.
// Only the person's own computers (their devices, by DeviceScope): a teammate cannot start a clone on someone else's PC, exactly
// as they cannot start a session there. Cloning needs the computer's own say-so: its worker reports allowClone and projectsDir.

export type TurboDevice = {
  id: string;
  name: string;
  /** ready: it will clone; off: its worker has cloning switched off; old: its worker does not know turbo mode yet. */
  clone: 'ready' | 'off' | 'old';
  /** Where the repo will land ("D:\Work\name"); only when ready. */
  destination?: string;
  /** The repo (or a folder with the same git remote) is already on this computer. */
  has: boolean;
};
export type TurboInfo = { /** owner/name of the project's repo, or null when it has none. */ repo: string | null; devices: TurboDevice[] };

/** First code location with a git remote: what to clone, and its owner/name. */
function repoOf(code: { remote?: string; host?: string }[] | undefined): { spec: string; repo: string } | null {
  for (const l of code ?? []) {
    const spec = cloneSpec(l);
    if (spec && l.remote) return { spec, repo: l.remote };
  }
  return null;
}

/** The folder name the worker will use (it applies the same rule): last part of the repo name, plain characters. */
export function folderNameOf(repo: string): string {
  const n = (repo.split('/').pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/[. ]+$/, '');
  return (n || 'repo').slice(0, 80);
}

export function destinationOf(projectsDir: string, repo: string): string {
  const sep = projectsDir.includes('\\') ? '\\' : '/';
  return `${projectsDir.replace(/[\\/]+$/, '')}${sep}${folderNameOf(repo)}`;
}

function cloneState(w: DeviceDoc['worker']): TurboDevice['clone'] {
  if (!w || w.allowClone === undefined) return 'old';
  return w.allowClone === true && w.projectsDir ? 'ready' : 'off';
}

/** What the page shows per computer: whether the repo is there already (`have`: its linked and suggested folders) and whether Claude can clone it. */
export async function turboInfo(scope: Scope, projectId: string, have: { folders: Pick<FolderView, 'deviceId'>[]; suggestions: Pick<FolderView, 'deviceId'>[] }): Promise<TurboInfo> {
  const c = await scoped(scope);
  const [p, devs] = await Promise.all([c.projects.findOne({ _id: projectId }, { projection: { code: 1 } }), c.devices.find({ revokedAt: null }, { projection: { name: 1, worker: 1 } }).toArray()]);
  const r = repoOf(p?.code);
  const there = new Set([...have.folders, ...have.suggestions].map(f => f.deviceId));
  return {
    repo: r?.repo ?? null,
    devices: devs.map(d => {
      const clone = cloneState(d.worker);
      return { id: d._id, name: d.name, clone, ...(clone === 'ready' && r ? { destination: destinationOf(d.worker!.projectsDir!, r.repo) } : {}), has: there.has(d._id) };
    }),
  };
}

/** Is there a computer of this person that would clone this project's repo? (Give to Claude: a project with no folder yet is fine then.) */
export async function turboAvailable(scope: Scope, projectId: string): Promise<{ repo: string; destination: string; deviceName: string } | null> {
  const c = await scoped(scope);
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  const r = repoOf(p?.code);
  if (!r) return null;
  const d = (await c.devices.find({ revokedAt: null }, { projection: { name: 1, worker: 1 } }).toArray()).find(x => cloneState(x.worker) === 'ready');
  return d ? { repo: r.repo, destination: destinationOf(d.worker!.projectsDir!, r.repo), deviceName: d.name } : null;
}

/** The session row (state starting, cloning) and the clone-and-start job. Also used by the dispatcher (`dispatched`: the fixed template is the prompt). */
export async function createCloneJob(scope: Scope, deviceId: string, projectId: string, r: { spec: string; repo: string }, text: string, dispatched?: { taskId: string; sessionId: string }): Promise<string> {
  if (text.length > 4000) throw new InputError('First message is too long (max 4000 characters)');
  const sessionId = dispatched?.sessionId ?? randomUUID();
  const c = await scoped(scope);
  const now = new Date();
  await c.workerSessions.insertOne({ _id: sessionId, orgId: scope.orgId, ownerId: scope.userId, deviceId, folderId: '', projectId, cloning: true, repo: r.repo, state: 'starting', startedAt: now, updatedAt: now, ...(dispatched ? { dispatched: true, taskId: dispatched.taskId } : {}) });
  try {
    await addJob(scope, deviceId, { kind: 'start', sessionId, projectId, clone: { repo: r.spec }, ...(text ? { prompt: text } : {}) });
  } catch (err) {
    await c.workerSessions.deleteOne({ _id: sessionId });
    throw err;
  }
  return sessionId;
}

/** A project's folder on one computer: a linked one, else a scanned one with the project's git remote (not linked yet). */
export async function folderOnDevice(c: Awaited<ReturnType<typeof scoped>>, deviceId: string, projectId: string, remotes: string[]): Promise<{ linked?: WorkerFolderDoc; suggested?: WorkerFolderDoc }> {
  const linked = await c.workerFolders.find({ deviceId, projectId, missing: false }).sort({ name: 1 }).limit(1).toArray();
  if (linked[0]) return { linked: linked[0] };
  if (!remotes.length) return {};
  const sugg = await c.workerFolders.find({ deviceId, projectId: null, missing: false, remote: { $in: remotes } }).sort({ name: 1 }).limit(1).toArray();
  return sugg[0] ? { suggested: sugg[0] } : {};
}

/**
 * Start Claude on a project on one of the person's computers, whatever is there: a linked folder starts as it does today; a
 * scanned folder with the project's git remote is linked and started; otherwise (the repo is not there) the computer clones it,
 * links the new folder and starts. Throws plain-words errors the Start sheet shows.
 */
export async function turboStart(scope: Scope, projectId: string, deviceId: string, prompt?: string): Promise<string> {
  const c = await scoped(scope);
  const devices = await deviceMap(scope);
  if (!devices.has(deviceId)) throw new NotFoundError('Computer not found');
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  if (!p) throw new NotFoundError('Project not found');
  const r = repoOf(p.code);
  const remotes = (p.code ?? []).map(l => l.remote).filter((x): x is string => !!x);
  const there = await folderOnDevice(c, deviceId, projectId, remotes);
  const text = prompt?.trim() ?? '';
  if (there.linked) return startSession(scope, projectId, there.linked._id, text);
  if (there.suggested) {
    await linkFolder(scope, projectId, there.suggested._id);
    return startSession(scope, projectId, there.suggested._id, text);
  }
  if (!r) throw new InputError('This project has no repository yet. Add it in Info › Code to let your PC clone it, or link a folder.');
  const dev = await c.devices.findOne({ _id: deviceId, revokedAt: null }, { projection: { name: 1, worker: 1 } });
  const st = cloneState(dev?.worker);
  if (st === 'off') throw new InputError(`Cloning is turned off on ${dev?.name ?? 'that computer'}. Link a folder instead, or set allowClone to true in its worker settings.`);
  if (st === 'old') throw new InputError(`${dev?.name ?? 'That computer'} runs an older worker that cannot clone yet. Update it under Claude › Setup, or link a folder.`);
  return createCloneJob(scope, deviceId, projectId, r, text);
}

/**
 * Dispatcher: no folder of the project on this computer. Returns what to do: link-and-use a scanned folder, clone, or nothing (null)
 * when the person has a folder somewhere else (that computer takes it), the project has no repo, or this computer does not clone.
 */
export async function turboPlanFor(c: Awaited<ReturnType<typeof scoped>>, deviceId: string, projectId: string, worker: DeviceDoc['worker']): Promise<{ folder: WorkerFolderDoc } | { clone: { spec: string; repo: string } } | null> {
  const p = await c.projects.findOne({ _id: projectId }, { projection: { code: 1 } });
  const r = repoOf(p?.code);
  if (!r) return null;
  const mine = (await c.devices.find({ revokedAt: null }, { projection: { _id: 1 } }).toArray()).map(d => d._id);
  if (await c.workerFolders.findOne({ projectId, missing: false, deviceId: { $in: mine } }, { projection: { _id: 1 } })) return null;
  const remotes = (p?.code ?? []).map(l => l.remote).filter((x): x is string => !!x);
  const here = await folderOnDevice(c, deviceId, projectId, remotes);
  if (here.suggested) {
    await c.workerFolders.updateOne({ _id: here.suggested._id, projectId: null }, { $set: { projectId, linkedAt: new Date() } });
    return { folder: { ...here.suggested, projectId, linkedAt: new Date() } };
  }
  if (await c.workerFolders.findOne({ projectId: null, missing: false, deviceId: { $in: mine }, remote: { $in: remotes } }, { projection: { _id: 1 } })) return null;
  return cloneState(worker) === 'ready' ? { clone: r } : null;
}
