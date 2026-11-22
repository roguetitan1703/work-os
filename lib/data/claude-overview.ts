import 'server-only';
import { scoped } from '../scope';
import { connectedDevice } from '../live';
import { deviceMap, derivedState, ownedDeviceIds, reopenPrompts, WAITING_MS, type DeviceScope, type ReopenPrompt, type SessionView } from './launcher';
import { friendlyError } from '../worker-errors';
import type { SessionOrigin } from '../db';
import { presenceState } from './presence-state';

// The Claude area (/claude) reads everything Claude-related across projects in one go: every Claude Code session on
// their computers (named, from the worker's list) and the computers' activity. Read-only; the writes go through the
// launcher actions. Call it only from signed-in pages/actions.

/** Written in the last 2 minutes (or subagents working): "working". Open but quiet for 15 minutes: "idle". */
export const WORKING_MS = 2 * 60_000;
export const IDLE_MS = 15 * 60_000;
/** A computer's session list older than this is dropped (the computer is off or the worker stopped). */
const LIST_DROP_MS = 6 * 3600_000;

/** Counts a computer last reported (numbers only). `fresh` is false after ACTIVITY_STALE_MS without news: then show "no news", not the old numbers. */
export type ComputerActivity = { deviceId: string; name: string; fresh: boolean; sessions: number; sessionsWorkOs: number; sessionsOther: number; subagents: number; at: string };
export type ActivityTotal = { sessions: number; sessionsWorkOs: number; sessionsOther: number; subagents: number; /** Computers with fresh numbers. */ reporting: number };

export type SessionRowState = 'working' | 'open' | 'idle' | 'starting' | 'closed' | 'stopped' | 'failed' | 'unknown';
/** One Claude Code session on one computer. Work OS can act only on the ones it started (`workOsId` set). */
export type SessionRow = {
  key: string;
  title: string;
  folder: string;
  /** What the session is doing: its set_doing task ("#N title") or the last result it reported; the owner's own sessions only. */
  doing?: string;
  projectId: string | null;
  projectName: string | null;
  /** H13: no project owns the session's folder ("not filed"); this is the one unlinked folder of that name on its computer, for the Link to project picker. */
  folderKey?: string;
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
  /** Why it waits when its Claude Code hook says so: a permission prompt in its terminal (only the owner sees this tab). */
  waitingWhy?: 'prompt';
  /** Turbo mode: a new repo cloned but not trusted automatically; Claude Code asks on that computer (first 10 minutes). */
  needsTrust?: boolean;
  /** Turbo mode: its computer is cloning the repo before the session starts. */
  cloning?: true;
  error?: string;
  /** Where it was last used (VS Code, a terminal, other), when the worker reports it. */
  origin?: SessionOrigin;
  /** Started by the task dispatcher: it runs on its own run key, so it opens only with Resume (never in VS Code). */
  dispatched?: true;
  /** The computer is online and it is not a dispatched run, so Open in VS Code can be sent. */
  canVscode: boolean;
  canStop: boolean;
  canResume: boolean;
  canRemove: boolean;
};
export type ComputerSummary = { deviceId: string; name: string; fresh: boolean; sessions: number; working: number; subagents: number };
export type SessionSummary = { computers: ComputerSummary[]; sessions: number; working: number; subagents: number; reporting: number };

export type ClaudeOverview = {
  sessions: SessionRow[];
  summary: SessionSummary;
  hasComputers: boolean;
  activity: { computers: ComputerActivity[]; total: ActivityTotal };
  /** Sessions that were open before a computer restarted (docs/ops/launcher.md). */
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

function liveState(running: boolean, lastMs: number, subagents: number, nowMs: number): SessionRowState {
  if (!running) return 'closed';
  if (subagents > 0 || nowMs - lastMs <= WORKING_MS) return 'working';
  return nowMs - lastMs > IDLE_MS ? 'idle' : 'open';
}

/**
 * Sessions and computers are the signed-in person's own (scope).
 * `card` (Today's Claude card): no reopen prompts.
 */
export async function claudeOverview(scope: DeviceScope, opts: { card?: boolean } = {}): Promise<ClaudeOverview> {
  const c = await scoped(scope);
  const nowMs = Date.now();
  const mine = await ownedDeviceIds(scope);
  const [devices, live, ended, projects, activity, reporting, reopen] = await Promise.all([
    deviceMap(scope),
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
  // What each session's own Claude Code hook last reported (the owner's rows only, keyed by Claude Code's session id): it beats guessing from transcript timing.
  const hookRows = reportedIds.length ? await c.presence.find({ userId: scope.userId, ccSession: { $in: reportedIds }, activity: { $exists: true } }, { projection: { ccSession: 1, projectId: 1, activity: 1, endedAt: 1, lastSeen: 1, doing: 1, lastResult: 1 } }).toArray() : [];
  const hookOf = new Map<string, (typeof hookRows)[number]>();
  for (const r of hookRows) {
    const prev = r.ccSession ? hookOf.get(r.ccSession) : undefined;
    if (r.ccSession && (!prev || (r.activity?.at.getTime() ?? 0) > (prev.activity?.at.getTime() ?? 0))) hookOf.set(r.ccSession, r);
  }

  // What each session is doing, in one line: its set_doing task ("#N title", read through the scoped door), else the last result it reported.
  const doingIds = [...new Set(hookRows.flatMap(r => (r.doing ? [r.doing.taskId] : [])))];
  const doingTasks = doingIds.length ? await c.tasks.find({ _id: { $in: doingIds } }, { projection: { ref: 1, title: 1 } }).toArray() : [];
  const doingTitle = new Map(doingTasks.map(t => [t._id, `#${t.ref} ${t.title}`]));
  const doingOf = (r: (typeof hookRows)[number] | undefined): string | undefined => {
    if (!r) return undefined;
    const t = r.doing ? doingTitle.get(r.doing.taskId) : undefined;
    const text = t ?? r.lastResult?.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    return text || undefined;
  };

  // Folders: name and "still linked" for Work OS sessions; linked folders by (computer, name) to find a reported session's project.
  const wsAll = [...live, ...ended].filter(s => !!s.projectId);
  const folderIds = [...new Set(wsAll.map(s => `${s.deviceId}:${s.folderId}`))];
  const deviceIds = [...devices.keys()];
  const [folderDocs, linkedFolders, openFolders] = await Promise.all([
    folderIds.length ? c.workerFolders.find({ _id: { $in: folderIds } }).toArray() : Promise.resolve([]),
    deviceIds.length ? c.workerFolders.find({ deviceId: { $in: deviceIds }, projectId: { $ne: null }, missing: false }, { projection: { deviceId: 1, name: 1, projectId: 1 } }).toArray() : Promise.resolve([]),
    // Unlinked folders by (computer, name): a session in a folder no project owns can be filed from its row (H13).
    deviceIds.length ? c.workerFolders.find({ deviceId: { $in: deviceIds }, projectId: null, missing: false }, { projection: { deviceId: 1, name: 1 } }).limit(3000).toArray() : Promise.resolve([]),
  ]);
  const folderOf = new Map(folderDocs.map(f => [f._id, f]));
  const projByFolder = new Map<string, Set<string>>();
  for (const f of linkedFolders) {
    const k = `${f.deviceId}:${lastSeg(f.name)}`;
    (projByFolder.get(k) ?? projByFolder.set(k, new Set()).get(k)!).add(f.projectId!);
  }
  const unlinkedBy = new Map<string, string[]>();
  for (const f of openFolders) {
    const k = `${f.deviceId}:${lastSeg(f.name)}`;
    unlinkedBy.set(k, [...(unlinkedBy.get(k) ?? []), f._id]);
  }
  const folderKeyFor = (deviceId: string, folder: string) => {
    const l = unlinkedBy.get(`${deviceId}:${folder}`);
    return l && l.length === 1 ? l[0] : undefined;
  };
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
      let waitingPrompt = false;
      const hook = hookOf.get(it.sessionId);
      if (hook && it.running && !stale && (state === 'working' || state === 'open' || state === 'idle')) {
        const h = presenceState(hook, { now: nowMs, daemon: 'running' });
        if (h.state === 'working') state = 'working';
        else if (h.state === 'waiting' && h.why === 'prompt') waitingPrompt = true;
        else if (h.state === 'off') state = 'closed';
        else if (h.state === 'on' || h.state === 'idle') state = it.subagentsActive > 0 ? 'working' : state === 'idle' ? 'idle' : 'open';
      }
      if (stale && state !== 'closed' && state !== 'stopped' && state !== 'failed') state = 'unknown';
      // The session's own start_work (its hook row) names its project; the folder name is only a guess (a `cd` into a subfolder breaks it).
      const projectId = own?.projectId ?? hook?.projectId ?? projectFor(d._id, it.folder);
      const f = own ? folderOf.get(`${own.deviceId}:${own.folderId}`) : undefined;
      const linked = !!own && !!f && f.projectId === own.projectId;
      const isLive = state === 'working' || state === 'open' || state === 'idle' || state === 'starting';
      rows.push({
        key: `${d._id}:${it.sessionId}`,
        title: it.title,
        folder: it.folder,
        ...(doingOf(hook) ? { doing: doingOf(hook) } : {}),
        projectId,
        projectName: projectId ? pname(projectId) : null,
        ...(!projectId && folderKeyFor(d._id, it.folder) ? { folderKey: folderKeyFor(d._id, it.folder) } : {}),
        deviceId: d._id,
        deviceName: dev.name,
        state,
        live: isLive,
        subagents: stale ? 0 : it.subagentsActive,
        lastActiveAt: it.lastActiveAt.toISOString(),
        workOs: it.startedByWorkOs || !!own,
        ...(own && own.projectId ? { workOsId: own._id, controlProjectId: own.projectId } : {}),
        ...(waitingPrompt ? { waiting: true, waitingWhy: 'prompt' as const } : own && own.state === 'starting' && nowMs - own.updatedAt.getTime() > WAITING_MS ? { waiting: true } : {}),
        ...(own?.needsTrust && isLive && nowMs - own.startedAt.getTime() < 10 * 60_000 ? { needsTrust: true } : {}),
        ...(own?.error ? { error: friendlyError(own.error) } : {}),
        ...(it.origin ? { origin: it.origin } : {}),
        ...(doc?.dispatched ? { dispatched: true as const } : {}),
        // A dispatched run opens with its own key only (Resume), never with the person's in VS Code. A Claude desktop app session
        // lives in the app: opening it in VS Code as well would run one conversation in two places.
        canVscode: dev.online && !doc?.dispatched && it.origin !== 'desktop',
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
    const folder = f ? lastSeg(f.name) : s.folderId || (s.repo ? lastSeg(s.repo) : 'new folder');
    const isLive = st === 'running' || st === 'starting';
    const linked = !!f && f.projectId === s.projectId;
    rows.push({
      key: `${s.deviceId}:${s._id}`,
      title: s.cloning && st === 'starting' ? `${folder} (cloning…)` : folder,
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
      ...(st === 'starting' && !s.cloning && nowMs - s.updatedAt.getTime() > WAITING_MS ? { waiting: true } : {}),
      ...(s.cloning && st === 'starting' ? { cloning: true as const } : {}),
      ...(s.needsTrust && isLive && nowMs - s.startedAt.getTime() < 10 * 60_000 ? { needsTrust: true } : {}),
      ...(s.error ? { error: friendlyError(s.error) } : {}),
      ...(s.dispatched ? { dispatched: true as const } : {}),
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

  return { sessions: rows, summary, hasComputers: devices.size > 0, activity, reopen };
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
