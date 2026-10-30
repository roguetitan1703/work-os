import 'server-only';
import { scoped, type Scope } from '../scope';
import { toItem } from './claude-items';
import type { ClaudeItem } from '../types';
import { connectedDevice } from '../live';
import { deviceMap, derivedState, ownedDeviceIds, reopenPrompts, WAITING_MS, type DeviceScope, type ReopenPrompt, type SessionView } from './launcher';
import { friendlyError } from '../worker-errors';
import type { SessionOrigin } from '../db';

// The Claude area (/claude) reads everything Claude-related across projects in one go: what
// waits on the person, every Claude Code session on their computers (named, from the worker's list), and the
// open queue. Read-only; the writes go through the existing item and launcher actions. Call it only
// from signed-in pages/actions.

const OPEN = ['queued', 'active', 'blocked'] as const;

/** Written in the last 2 minutes (or subagents working): "working". Open but quiet for 15 minutes: "idle". */
export const WORKING_MS = 2 * 60_000;
export const IDLE_MS = 15 * 60_000;
/** A computer's session list older than this is dropped (the computer is off or the worker stopped). */
const LIST_DROP_MS = 6 * 3600_000;

export type NeedsYouItem = { id: string; ref: number; projectId: string; projectName: string; title: string; question: string; updatedAt: string };
export type QueueGroup = { projectId: string; projectName: string; items: ClaudeItem[]; blockers: Record<string, { ref: number; title: string; state: string }> };
/** Counts a computer last reported (numbers only). `fresh` is false after ACTIVITY_STALE_MS without news: then show "no news", not the old numbers. */
export type ComputerActivity = { deviceId: string; name: string; fresh: boolean; sessions: number; sessionsWorkOs: number; sessionsOther: number; subagents: number; at: string };
export type ActivityTotal = { sessions: number; sessionsWorkOs: number; sessionsOther: number; subagents: number; /** Computers with fresh numbers. */ reporting: number };

export type SessionRowState = 'working' | 'open' | 'idle' | 'starting' | 'closed' | 'stopped' | 'failed' | 'unknown';
/** One Claude Code session on one computer. Work OS can act only on the ones it started (`workOsId` set). */
export type SessionRow = {
  key: string;
  title: string;
  folder: string;
  projectId: string | null;
  projectName: string | null;
  deviceId: string;
  deviceName: string;
  state: SessionRowState;
  /** Still running (or starting), as far as the computer knows. */
  live: boolean;
  subagents: number;
  lastActiveAt: string | null;
  workOs: boolean;
  /** Id for Stop/Resume/Remove: only for sessions Work OS started. */
  workOsId?: string;
  /** Project the session is controlled under (Work OS ones). */
  controlProjectId?: string;
  waiting?: boolean;
  error?: string;
  /** Where it was last used (VS Code, a terminal, other), when the worker reports it. */
  origin?: SessionOrigin;
  /** The computer is online, so Open in VS Code can be sent. */
  canVscode: boolean;
  canStop: boolean;
  canResume: boolean;
  canRemove: boolean;
};
export type ComputerSummary = { deviceId: string; name: string; fresh: boolean; sessions: number; working: number; subagents: number };
export type SessionSummary = { computers: ComputerSummary[]; sessions: number; working: number; subagents: number; reporting: number };

export type ClaudeOverview = {
  needsYou: NeedsYouItem[];
  sessions: SessionRow[];
  summary: SessionSummary;
  queue: QueueGroup[];
  hasComputers: boolean;
  activity: { computers: ComputerActivity[]; total: ActivityTotal };
  /** Sessions that were open before a computer restarted (docs/launcher.md). */
  reopen: ReopenPrompt[];
};

// The worker reports about every 2 min, or, while it holds a push stream (lib/live.ts), only when something changed:
// a connected computer's last report is current however old it is.
export const ACTIVITY_STALE_MS = 5 * 60_000;

const lastSeg = (p: string) => p.split(/[\\/]+/).filter(Boolean).pop() ?? p;

/** Latest reported counts per computer plus a total over the computers that are not stale. Read-only. */
export async function activityOverview(scope: DeviceScope): Promise<ClaudeOverview['activity']> {
  const c = await scoped(scope);
  const ds = await c.devices.find({ revokedAt: null, activity: { $exists: true } }, { projection: { name: 1, activity: 1 } }).sort({ name: 1 }).toArray();
  const nowMs = Date.now();
  const computers: ComputerActivity[] = ds.flatMap(d => {
    const a = d.activity;
    if (!a) return [];
    return [{ deviceId: d._id, name: d.name, fresh: nowMs - a.at.getTime() <= ACTIVITY_STALE_MS || connectedDevice(d._id), sessions: a.sessions, sessionsWorkOs: a.sessionsWorkOs, sessionsOther: a.sessionsOther, subagents: a.subagents, at: a.at.toISOString() }];
  });
  const total: ActivityTotal = { sessions: 0, sessionsWorkOs: 0, sessionsOther: 0, subagents: 0, reporting: 0 };
  for (const x of computers) {
    if (!x.fresh) continue;
    total.sessions += x.sessions; total.sessionsWorkOs += x.sessionsWorkOs; total.sessionsOther += x.sessionsOther; total.subagents += x.subagents; total.reporting++;
  }
  return { computers, total };
}

/** How many open Claude items wait on the caller (for a nav badge). One indexed count. */
export async function needsYouCount(s: Scope): Promise<number> {
  const c = await scoped(s);
  return c.claudeItems.countDocuments({ waitingOn: s.userId, state: { $in: [...OPEN] } });
}

function liveState(running: boolean, lastMs: number, subagents: number, nowMs: number): SessionRowState {
  if (!running) return 'closed';
  if (subagents > 0 || nowMs - lastMs <= WORKING_MS) return 'working';
  return nowMs - lastMs > IDLE_MS ? 'idle' : 'open';
}

/**
 * Sessions and computers are the signed-in person's own (scope); the open Claude items are shared.
 * `card` (Today's Claude card): only the items waiting on the caller, no queue (empty) and no blockers.
 */
export async function claudeOverview(scope: DeviceScope, opts: { card?: boolean } = {}): Promise<ClaudeOverview> {
  const c = await scoped(scope);
  const nowMs = Date.now();
  const mine = await ownedDeviceIds(scope);
  const [devices, items, live, ended, projects, activity, reporting, reopen] = await Promise.all([
    deviceMap(scope),
    c.claudeItems.find({ state: { $in: [...OPEN] }, ...(opts.card ? { waitingOn: scope.userId } : {}) }).sort({ order: 1 }).toArray(),
    c.workerSessions.find({ state: { $in: ['starting', 'running'] }, deviceId: { $in: mine }, hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(50).toArray(),
    c.workerSessions.find({ state: { $in: ['dead', 'stopped', 'failed'] }, deviceId: { $in: mine }, hidden: { $ne: true } }).sort({ updatedAt: -1 }).limit(15).toArray(),
    c.projects.find({}, { projection: { name: 1 } }).toArray(),
    activityOverview(scope),
    c.devices.find({ revokedAt: null, claudeSessions: { $exists: true } }, { projection: { name: 1, claudeSessions: 1 } }).toArray(),
    opts.card ? Promise.resolve([] as ReopenPrompt[]) : reopenPrompts(scope),
  ]);
  const names = new Map(projects.map(p => [p._id, p.name]));
  const pname = (id: string) => names.get(id) ?? id;

  // Work OS-started sessions by id (any visibility, so a removed one does not come back through the worker's list).
  const reportedIds = reporting.flatMap(d => (d.claudeSessions?.items ?? []).map(i => i.sessionId));
  const known = reportedIds.length ? await c.workerSessions.find({ _id: { $in: reportedIds }, deviceId: { $in: mine } }).toArray() : [];
  const wsById = new Map([...known, ...live, ...ended].map(s => [s._id, s]));

  // Folders: name and "still linked" for Work OS sessions; linked folders by (computer, name) to find a reported session's project.
  const wsAll = [...live, ...ended].filter(s => !!s.projectId);
  const folderIds = [...new Set(wsAll.map(s => `${s.deviceId}:${s.folderId}`))];
  const deviceIds = [...devices.keys()];
  const [folderDocs, linkedFolders] = await Promise.all([
    folderIds.length ? c.workerFolders.find({ _id: { $in: folderIds } }).toArray() : Promise.resolve([]),
    deviceIds.length ? c.workerFolders.find({ deviceId: { $in: deviceIds }, projectId: { $ne: null }, missing: false }, { projection: { deviceId: 1, name: 1, projectId: 1 } }).toArray() : Promise.resolve([]),
  ]);
  const folderOf = new Map(folderDocs.map(f => [f._id, f]));
  const projByFolder = new Map<string, Set<string>>();
  for (const f of linkedFolders) {
    const k = `${f.deviceId}:${lastSeg(f.name)}`;
    (projByFolder.get(k) ?? projByFolder.set(k, new Set()).get(k)!).add(f.projectId!);
  }
  const projectFor = (deviceId: string, folder: string) => {
    const s = projByFolder.get(`${deviceId}:${folder}`);
    return s && s.size === 1 ? [...s][0] : null;
  };

  const rows: SessionRow[] = [];
  const seen = new Set<string>();

  // 1. What each computer's worker reports: every Claude Code session, named.
  for (const d of reporting) {
    const list = d.claudeSessions;
    const dev = devices.get(d._id);
    if (!list || !dev || nowMs - list.at.getTime() > LIST_DROP_MS) continue;
    const stale = nowMs - list.at.getTime() > ACTIVITY_STALE_MS && !connectedDevice(d._id);
    for (const it of list.items) {
      const doc = wsById.get(it.sessionId);
      if (doc && doc.deviceId === d._id && doc.hidden) continue;
      const own = doc && doc.deviceId === d._id ? doc : undefined;
      seen.add(`${d._id}:${it.sessionId}`);
      const lastMs = it.lastActiveAt.getTime();
      let state: SessionRowState = liveState(it.running, lastMs, it.subagentsActive, nowMs);
      if (own && !it.running && (own.state === 'starting' || own.state === 'stopped' || own.state === 'failed')) state = own.state === 'starting' ? 'starting' : own.state;
      if (stale && state !== 'closed' && state !== 'stopped' && state !== 'failed') state = 'unknown';
      const projectId = own?.projectId ?? projectFor(d._id, it.folder);
      const f = own ? folderOf.get(`${own.deviceId}:${own.folderId}`) : undefined;
      const linked = !!own && !!f && f.projectId === own.projectId;
      const isLive = state === 'working' || state === 'open' || state === 'idle' || state === 'starting';
      rows.push({
        key: `${d._id}:${it.sessionId}`,
        title: it.title,
        folder: it.folder,
        projectId,
        projectName: projectId ? pname(projectId) : null,
        deviceId: d._id,
        deviceName: dev.name,
        state,
        live: isLive,
        subagents: stale ? 0 : it.subagentsActive,
        lastActiveAt: it.lastActiveAt.toISOString(),
        workOs: it.startedByWorkOs || !!own,
        ...(own && own.projectId ? { workOsId: own._id, controlProjectId: own.projectId } : {}),
        ...(own && own.state === 'starting' && nowMs - own.updatedAt.getTime() > WAITING_MS ? { waiting: true } : {}),
        ...(own?.error ? { error: friendlyError(own.error) } : {}),
        ...(it.origin ? { origin: it.origin } : {}),
        canVscode: dev.online,
        canStop: !!own?.projectId && (isLive || state === 'unknown'),
        canResume: !!own?.projectId && linked && !isLive && state !== 'unknown',
        canRemove: !!own?.projectId && !isLive,
      });
    }
  }

  // 2. Work OS sessions the worker's list does not show (ended ones, a worker without the list, a computer that is off).
  for (const s of wsAll) {
    if (seen.has(`${s.deviceId}:${s._id}`)) continue;
    const dev = devices.get(s.deviceId);
    const f = folderOf.get(`${s.deviceId}:${s.folderId}`);
    const st: SessionView['state'] = derivedState(s);
    const state: SessionRowState = st === 'running' ? 'open' : st === 'dead' ? 'closed' : st;
    const folder = f ? lastSeg(f.name) : s.folderId;
    const isLive = st === 'running' || st === 'starting';
    const linked = !!f && f.projectId === s.projectId;
    rows.push({
      key: `${s.deviceId}:${s._id}`,
      title: folder,
      folder,
      projectId: s.projectId!,
      projectName: pname(s.projectId!),
      deviceId: s.deviceId,
      deviceName: dev?.name ?? 'revoked computer',
      state,
      live: isLive,
      subagents: 0,
      lastActiveAt: s.updatedAt.toISOString(),
      workOs: true,
      workOsId: s._id,
      controlProjectId: s.projectId!,
      ...(st === 'starting' && nowMs - s.updatedAt.getTime() > WAITING_MS ? { waiting: true } : {}),
      ...(s.error ? { error: friendlyError(s.error) } : {}),
      canVscode: false, // not in the computer's own list: it has no transcript to open
      canStop: isLive || st === 'unknown',
      canResume: linked && !isLive,
      canRemove: !isLive,
    });
  }
  rows.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));

  // Summary per computer: live rows when the computer sent a list, else the counts it reported.
  const hasList = new Set(reporting.filter(d => d.claudeSessions && nowMs - d.claudeSessions.at.getTime() <= LIST_DROP_MS).map(d => d._id));
  const actBy = new Map(activity.computers.map(a => [a.deviceId, a]));
  const comps: ComputerSummary[] = [];
  for (const [id, dev] of [...devices].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const mine = rows.filter(r => r.deviceId === id);
    const act = actBy.get(id);
    if (!mine.length && !act && !hasList.has(id)) continue;
    const fresh = act ? act.fresh : false;
    const liveRows = mine.filter(r => r.live);
    const useRows = hasList.has(id) || liveRows.length > 0;
    comps.push({
      deviceId: id,
      name: dev.name,
      fresh,
      sessions: useRows ? liveRows.length : act?.sessions ?? 0,
      working: liveRows.filter(r => r.state === 'working').length,
      subagents: useRows ? liveRows.reduce((n, r) => n + r.subagents, 0) : act?.subagents ?? 0,
    });
  }
  const summary: SessionSummary = { computers: comps, sessions: 0, working: 0, subagents: 0, reporting: 0 };
  for (const x of comps) {
    if (!x.fresh) continue;
    summary.sessions += x.sessions; summary.working += x.working; summary.subagents += x.subagents; summary.reporting++;
  }

  const needsYou = items
    .filter(d => d.waitingOn === scope.userId)
    .map(d => ({ id: d._id, ref: d.ref, projectId: d.projectId, projectName: pname(d.projectId), title: d.title, question: d.waitingText, updatedAt: d.updatedAt.toISOString() }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  if (opts.card) return { needsYou, sessions: rows, summary, queue: [], hasComputers: devices.size > 0, activity, reopen };

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
    sessions: rows,
    summary,
    queue: [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName)),
    hasComputers: devices.size > 0,
    activity,
    reopen,
  };
}

// ── Start Claude: which projects can start ──────────────────────────────────

export type StartProject = { id: string; name: string; client?: string; private?: boolean; /** Usable linked folders on non-revoked computers. */ folders: number; lastStartedAt: string | null };

/** Projects for the Start picker. Archived ones are left out. */
export async function startProjects(scope: DeviceScope): Promise<StartProject[]> {
  const c = await scoped(scope);
  const [devices, mine] = await Promise.all([deviceMap(scope), ownedDeviceIds(scope)]);
  const [projects, linked, last] = await Promise.all([
    c.projects.find({ status: { $ne: 'archived' } }, { projection: { name: 1, client: 1, visibility: 1 } }).sort({ nameLower: 1 }).toArray(),
    c.workerFolders
      .aggregate<{ _id: string; n: number }>([{ $match: { projectId: { $ne: null }, missing: false, deviceId: { $in: [...devices.keys()] } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }])
      .toArray(),
    c.workerSessions.aggregate<{ _id: string; at: Date }>([{ $match: { projectId: { $ne: null }, deviceId: { $in: mine } } }, { $group: { _id: '$projectId', at: { $max: '$startedAt' } } }]).toArray(),
  ]);
  const n = new Map(linked.map(x => [x._id, x.n]));
  const at = new Map(last.map(x => [x._id, x.at.toISOString()]));
  return projects.map(p => ({ id: p._id, name: p.name, ...(p.client ? { client: p.client } : {}), ...(p.visibility === 'private' ? { private: true } : {}), folders: n.get(p._id) ?? 0, lastStartedAt: at.get(p._id) ?? null }));
}
