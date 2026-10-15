import 'server-only';
import { collections } from '../db';
import { toItem } from './claude-items';
import type { ClaudeItem } from '../types';
import { deviceMap, derivedState, WAITING_MS, type SessionView } from './launcher';

// The Claude area (/claude) reads everything Claude-related across projects in one go: what
// waits on Om, live sessions, finished sessions and the open queue. Read-only; the writes go
// through the existing item and launcher actions. Call it only from signed-in pages/actions.

const OPEN = ['queued', 'active', 'blocked'] as const;

export type OverviewSession = SessionView & { projectId: string; projectName: string };
export type NeedsYouItem = { id: string; ref: number; projectId: string; projectName: string; title: string; question: string; updatedAt: string };
export type QueueGroup = { projectId: string; projectName: string; items: ClaudeItem[]; blockers: Record<string, { ref: number; title: string; state: string }> };
export type ClaudeOverview = { needsYou: NeedsYouItem[]; running: OverviewSession[]; recent: OverviewSession[]; queue: QueueGroup[]; hasComputers: boolean };

/** How many open Claude items wait on Om (for a nav badge). One indexed count. */
export async function needsYouCount(): Promise<number> {
  const c = await collections();
  return c.claudeItems.countDocuments({ state: { $in: [...OPEN] }, waitingOnOm: { $type: 'string', $ne: '' } });
}

export async function claudeOverview(): Promise<ClaudeOverview> {
  const c = await collections();
  const [devices, items, live, ended, projects] = await Promise.all([
    deviceMap(),
    c.claudeItems.find({ state: { $in: [...OPEN] } }).sort({ order: 1 }).toArray(),
    c.workerSessions.find({ state: { $in: ['starting', 'running'] }, hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(50).toArray(),
    c.workerSessions.find({ state: { $in: ['dead', 'stopped', 'failed'] }, hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(15).toArray(),
    c.projects.find({}, { projection: { name: 1 } }).toArray(),
  ]);
  const names = new Map(projects.map(p => [p._id, p.name]));
  const pname = (id: string) => names.get(id) ?? id;

  // Sessions: folder name and "still linked to this project" come from the folder docs.
  const sessions = [...live, ...ended].filter(s => !!s.projectId);
  const folders = sessions.length
    ? await c.workerFolders.find({ _id: { $in: [...new Set(sessions.map(s => `${s.deviceId}:${s.folderId}`))] } }).toArray()
    : [];
  const folderOf = new Map(folders.map(f => [f._id, f]));
  const view = (s: (typeof sessions)[number]): OverviewSession => {
    const f = folderOf.get(`${s.deviceId}:${s.folderId}`);
    return {
      id: s._id,
      projectId: s.projectId!,
      projectName: pname(s.projectId!),
      linked: !!f && f.projectId === s.projectId,
      waiting: s.state === 'starting' && Date.now() - s.updatedAt.getTime() > WAITING_MS,
      deviceName: devices.get(s.deviceId)?.name ?? 'revoked computer',
      folderName: f?.name ?? s.folderId,
      state: derivedState(s),
      startedAt: s.startedAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      ...(s.error ? { error: s.error } : {}),
    };
  };

  const needsYou = items
    .filter(d => d.waitingOnOm)
    .map(d => ({ id: d._id, ref: d.ref, projectId: d.projectId, projectName: pname(d.projectId), title: d.title, question: d.waitingOnOm, updatedAt: d.updatedAt.toISOString() }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const blockerIds = [...new Set(items.map(d => d.blockedBy).filter((x): x is string => !!x))];
  const blockerDocs = blockerIds.length ? await c.claudeItems.find({ _id: { $in: blockerIds } }, { projection: { ref: 1, title: 1, state: 1 } }).toArray() : [];
  const blockerMap = new Map(blockerDocs.map(b => [b._id, { ref: b.ref, title: b.title, state: b.state }]));

  const byProject = new Map<string, QueueGroup>();
  for (const d of items) {
    let g = byProject.get(d.projectId);
    if (!g) byProject.set(d.projectId, (g = { projectId: d.projectId, projectName: pname(d.projectId), items: [], blockers: {} }));
    g.items.push(toItem(d));
    if (d.blockedBy && blockerMap.has(d.blockedBy)) g.blockers[d.blockedBy] = blockerMap.get(d.blockedBy)!;
  }

  return {
    needsYou,
    running: live.filter(s => !!s.projectId).map(view),
    recent: ended.filter(s => !!s.projectId).map(view),
    queue: [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName)),
    hasComputers: devices.size > 0,
  };
}

// ── Start Claude: which projects can start ──────────────────────────────────

export type StartProject = { id: string; name: string; client?: string; /** Usable linked folders on non-revoked computers. */ folders: number; lastStartedAt: string | null };

/** Projects for the Start picker. Archived ones are left out. */
export async function startProjects(): Promise<StartProject[]> {
  const c = await collections();
  const devices = await deviceMap();
  const [projects, linked, last] = await Promise.all([
    c.projects.find({ status: { $ne: 'archived' } }, { projection: { name: 1, client: 1 } }).sort({ nameLower: 1 }).toArray(),
    c.workerFolders
      .aggregate<{ _id: string; n: number }>([{ $match: { projectId: { $ne: null }, missing: false, deviceId: { $in: [...devices.keys()] } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }])
      .toArray(),
    c.workerSessions.aggregate<{ _id: string; at: Date }>([{ $match: { projectId: { $ne: null } } }, { $group: { _id: '$projectId', at: { $max: '$startedAt' } } }]).toArray(),
  ]);
  const n = new Map(linked.map(x => [x._id, x.n]));
  const at = new Map(last.map(x => [x._id, x.at.toISOString()]));
  return projects.map(p => ({ id: p._id, name: p.name, ...(p.client ? { client: p.client } : {}), folders: n.get(p._id) ?? 0, lastStartedAt: at.get(p._id) ?? null }));
}
