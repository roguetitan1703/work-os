import 'server-only';
import { createHash } from 'node:crypto';
import type { PresenceDoc, PresenceState } from '../db';
import { orgWide, scoped, type Scope } from '../scope';
import { memberNames } from '../people';
import { presenceState, WORKING_MIN, GONE_MIN, type DaemonSays } from './presence-state';
import { openNeedRows } from './roster-needs';
import { slotHolders, machineKey } from './slots';

// The roster (docs/flows/plan-1-3.md slice 7): who is working on what, and where. A worker is a present session
// (presence rows, lib/data/presence.ts, grown with model, account, machine, branch, doing, parent and slot). The rows
// come through the scoped door, so a viewer sees only the workers on projects they can read.
//
// A worker's state is computed on every read, never typed by anyone, by presenceState (presence-state.ts, the one
// function; its header has the rules): on, working, waiting, idle or off. Off sessions show their task unheld.
// A session's Claude Code hook reports its own state (activity); other clients show working or idle from their last call.

export { WORKING_MIN, GONE_MIN };
/** Workers last seen longer ago than this are not listed at all. */
const LIST_HOURS = 24;
/** A daemon's session list older than this says nothing about whether the process still runs. */
const DAEMON_FRESH_MS = 5 * 60_000;

export type WorkerState = PresenceState;

export type WorkerRow = {
  id: string;
  session: string | null;
  person: string;
  mine: boolean;
  ai: string;
  /** Where it runs, as its hook says: desktop, vscode or terminal ('' when no hook said). */
  tool: string;
  model: string;
  account: string;
  machine: string;
  project: { id: string; name: string };
  branch: string;
  label: string;
  slot: string;
  doing: { ref: number; title: string; /** false when the worker is off: nobody holds the task */ held: boolean } | null;
  state: WorkerState;
  /** For a waiting worker: an open Need, or (own sessions only) a permission prompt in its terminal. */
  waitingOn?: 'need' | 'prompt';
  /** When the state began (the hook's last event, else the last call). */
  since: string;
  /** For an idle worker: how many unblocked Next lines its project has. */
  nextWork: number;
  lastSeen: string;
  /** 0, or 1 for a builder shown under its orchestrator. */
  depth: 0 | 1;
  /** A builder's orchestrator session id: only on the viewer's own rows (another person's session ids are not shown). */
  parent?: string;
};

export type CouldBeRunning = { projectId: string; projectName: string; unblocked: number; first: string };
export type Roster = { workers: WorkerRow[]; couldBeRunning: CouldBeRunning[]; machines: { machine: string; held: number; cap: number }[] };

type Raw = { row: PresenceDoc; daemon: DaemonSays };

/** Pure: the state of one worker at `now` (presenceState). `daemon` = what the worker daemon's fresh list says about its process; `needs` = it has an open Need. */
export function workerState(row: Pick<PresenceDoc, 'lastSeen' | 'activity'> & { endedAt?: Date | null }, o: { now: number; daemon?: DaemonSays; needs?: boolean }): WorkerState {
  return presenceState(row, o).state;
}

const OPEN_LINE_STATUS: ('Done' | 'Dropped' | 'Blocked')[] = ['Done', 'Dropped', 'Blocked'];

/** Projects of `ids` with unblocked Next lines in their State (no waitsOn; a line pointing at a closed or blocked task does not count). */
export async function unblockedNext(s: Scope, ids?: string[]): Promise<Map<string, { n: number; first: string; firstRef?: number }>> {
  const c = await scoped(s);
  const states = await c.states.find(ids ? { projectId: { $in: ids } } : {}, { projection: { projectId: 1, next: 1 } }).toArray();
  const refs: number[] = [];
  const pids: string[] = [];
  for (const st of states) {
    for (const l of st.next) if (l.ref && !l.waitsOn) refs.push(l.ref);
    pids.push(st.projectId);
  }
  const closed = new Set<string>();
  if (refs.length) {
    const ts = await c.tasks.find({ projectId: { $in: pids }, ref: { $in: refs }, status: { $in: OPEN_LINE_STATUS } }, { projection: { projectId: 1, ref: 1 } }).toArray();
    for (const t of ts) closed.add(`${t.projectId}:${t.ref}`);
  }
  const out = new Map<string, { n: number; first: string; firstRef?: number }>();
  for (const st of states) {
    const live = st.next.filter(l => !l.waitsOn && !(l.ref && closed.has(`${st.projectId}:${l.ref}`)));
    if (live.length) out.set(st.projectId, { n: live.length, first: live[0].text.slice(0, 160), ...(live[0].ref ? { firstRef: live[0].ref } : {}) });
  }
  return out;
}

async function loadRaw(s: Scope, hours: number, projectId?: string): Promise<Raw[]> {
  const c = await scoped(s);
  const rows = await c.presence.find({ lastSeen: { $gt: new Date(Date.now() - hours * 3_600_000) }, ...(projectId ? { projectId } : {}) }).sort({ lastSeen: -1 }).limit(300).toArray();
  if (!rows.length) return [];
  // Where the daemon reports, a session whose process still runs is not off however quiet it is, and one it lists as
  // stopped is off at once. The daemon belongs to the worker's own person, so it is read for the whole organization
  // (it answers only "running or not"). Rows a hook reports on are checked always; other rows only when quiet for over 30 minutes.
  // The daemon names a session by Claude Code's own UUID (ccSession; a call-based row's session id is that UUID too).
  const nowMs = Date.now();
  const ccOf = (r: PresenceDoc) => r.ccSession ?? r.session;
  const check = rows.filter(r => ccOf(r) && r.machineName && (r.activity || nowMs - r.lastSeen.getTime() > GONE_MIN * 60_000));
  const says = new Map<string, DaemonSays>();
  if (check.length) {
    // A device counts only for the person who owns it (a session cannot claim someone else's computer).
    const devs = await (await orgWide(s.orgId)).devices.find({ $or: check.map(r => ({ _id: r.machine, ownerId: r.userId })), revokedAt: null }, { projection: { claudeSessions: 1 } }).toArray();
    for (const d of devs) {
      const list = d.claudeSessions;
      if (!list || nowMs - list.at.getTime() > DAEMON_FRESH_MS) continue;
      for (const it of list.items) if (!it.unknown) says.set(`${d._id}:${it.sessionId}`, it.running ? 'running' : 'stopped'); // unknown: the computer has no word on it
    }
  }
  return rows.map(row => ({ row, daemon: (ccOf(row) && says.get(`${row.machine}:${ccOf(row)}`)) || 'unknown' }));
}

/** The kind of client, for people who are not the key's owner (a key's name is its owner's own label). */
export const clientWord = (agent: string): string => (agent === 'claude-code' ? 'Claude Code' : agent === 'claude' ? 'Claude' : agent);

/** Number and title of tasks, read through the scoped door: a task the viewer cannot read is simply absent. */
export async function taskInfo(s: Scope, ids: string[]): Promise<Map<string, { ref: number; title: string }>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const ts = await (await scoped(s)).tasks.find({ _id: { $in: uniq } }, { projection: { ref: 1, title: 1 } }).toArray();
  return new Map(ts.map(t => [t._id, { ref: t.ref, title: t.title }]));
}

/** What a row is called to someone who does not own it: the row id holds the session id, so they get a one-way label of it. */
const opaqueId = (rowId: string) => createHash('sha256').update(`worker-row:${rowId}`).digest('hex').slice(0, 16);

type Ctx = { tasks: Map<string, { ref: number; title: string }>; names: Record<string, string>; pname: Map<string, string>; needs: Set<string>; nextCount: (projectId: string) => number };

/** Rows for the screen: state computed, builders placed under their orchestrators, orchestrators ordered working first. */
function buildWorkers(s: Scope, raw: Raw[], x: Ctx): WorkerRow[] {
  const now = Date.now();
  const rows: (WorkerRow & { _parent?: string; _uid: string; _rid: string; _sess: string | null })[] = raw
    .filter(r => x.pname.has(r.row.projectId))
    .map(({ row, daemon }) => {
      const st = presenceState(row, { now, daemon, needs: x.needs.has(row._id) });
      const state = st.state;
      const mine = row.userId === s.userId;
      return {
        // Another person's session id never leaves the server: their row gets an opaque id and no session.
        id: mine ? row._id : opaqueId(row._id),
        session: mine ? (row.session ?? null) : null,
        person: x.names[row.userId] || 'a member',
        mine,
        ai: mine ? row.ai : clientWord(row.agent), // a key name is its owner's label: others see the kind of client
        tool: row.tool ?? '',
        model: row.model ?? '',
        account: row.account ?? '',
        machine: row.machineName ?? row.machine,
        project: { id: row.projectId, name: x.pname.get(row.projectId)! },
        branch: row.branch ?? '',
        label: row.label,
        slot: row.slot ?? '',
        doing: row.doing && x.tasks.get(row.doing.taskId) ? { ...x.tasks.get(row.doing.taskId)!, held: state !== 'off' } : null,
        state,
        // A permission prompt is the owner's business; teammates see only that it waits on a person.
        ...(state === 'waiting' ? { waitingOn: st.why === 'prompt' && !mine ? ('need' as const) : st.why } : {}),
        since: st.since.toISOString(),
        nextWork: state === 'idle' ? x.nextCount(row.projectId) : 0,
        lastSeen: row.lastSeen.toISOString(),
        depth: 0 as const,
        ...(row.userId === s.userId && row.parent ? { parent: row.parent } : {}),
        _parent: row.parent,
        _uid: row.userId,
        _rid: row._id,
        _sess: row.session ?? null,
      };
    });
  // Builders under their orchestrator (the one whose session id they named, same person).
  const rank: Record<WorkerState, number> = { working: 0, waiting: 1, on: 2, idle: 3, off: 4 };
  const bySession = new Map(rows.filter(r => r._sess).map(r => [`${r._uid}:${r._sess}`, r]));
  const kids = new Map<string, typeof rows>();
  const tops: typeof rows = [];
  for (const r of rows) {
    const p = r._parent ? bySession.get(`${r._uid}:${r._parent}`) : undefined;
    if (p && p !== r) kids.set(p._rid, [...(kids.get(p._rid) ?? []), r]);
    else tops.push(r);
  }
  const cmp = (a: WorkerRow, b: WorkerRow) => rank[a.state] - rank[b.state] || b.lastSeen.localeCompare(a.lastSeen);
  const workers: WorkerRow[] = [];
  for (const t of tops.sort(cmp)) {
    workers.push(strip(t, 0));
    for (const k of (kids.get(t._rid) ?? []).sort(cmp)) workers.push(strip(k, 1));
  }
  return workers;
}

/** The roster the viewer may see: workers, builders under their orchestrators, and the projects that could be running and are not. */
export async function roster(s: Scope): Promise<Roster> {
  const raw = await loadRaw(s, LIST_HOURS);
  const c = await scoped(s);
  const names = await memberNames(s.orgId);
  const projectIds = [...new Set(raw.map(r => r.row.projectId))];
  const projects = projectIds.length ? await c.projects.find({ _id: { $in: projectIds } }, { projection: { name: 1 } }).toArray() : [];
  const pname = new Map(projects.map(p => [p._id, p.name]));
  const needs = await openNeedRows(s, raw.map(r => r.row));
  const nextByProject = await unblockedNext(s, projectIds);
  const tasks = await taskInfo(s, raw.flatMap(r => (r.row.doing ? [r.row.doing.taskId] : [])));
  const workers = buildWorkers(s, raw, { tasks, names, pname, needs, nextCount: id => nextByProject.get(id)?.n ?? 0 });

  const keyOf = (r: PresenceDoc) => machineKey(r.userId, { machine: r.machine, machineName: r.machineName });
  const machineKeys = [...new Set(raw.filter(r => r.row.machine).map(r => keyOf(r.row)))];
  const held = await slotHolders(s, machineKeys);
  const display = new Map(raw.map(r => [keyOf(r.row), r.row.machineName ?? r.row.machine]));
  const machines = [...held].filter(([, v]) => v.held > 0).map(([k, v]) => ({ machine: display.get(k) ?? k, held: v.held, cap: v.cap }));

  return { workers, couldBeRunning: await couldBeRunning(s, raw), machines };
}

function strip(r: WorkerRow & { _parent?: string; _uid?: string; _rid?: string; _sess?: string | null }, depth: 0 | 1): WorkerRow {
  const { _parent, _uid, _rid, _sess, ...rest } = r;
  void _parent;
  void _uid;
  void _rid;
  void _sess;
  return { ...rest, depth };
}

/**
 * "Could be running and isn't": active projects the caller can read whose State has unblocked Next lines and no live
 * worker (a session not off: seen in the last 30 minutes, or one whose process the daemon reports). The digest calls this too.
 */
export async function couldBeRunning(s: Scope, loaded?: Raw[]): Promise<CouldBeRunning[]> {
  const c = await scoped(s);
  const next = await unblockedNext(s);
  if (!next.size) return [];
  const raw = loaded ?? (await loadRaw(s, 1));
  const now = Date.now();
  const live = new Set(raw.filter(r => workerState(r.row, { now, daemon: r.daemon }) !== 'off').map(r => r.row.projectId));
  const ids = [...next.keys()].filter(id => !live.has(id));
  if (!ids.length) return [];
  const projects = await c.projects.find({ _id: { $in: ids }, status: 'active' }, { projection: { name: 1, nameLower: 1 } }).sort({ nameLower: 1 }).toArray();
  return projects.map(p => ({ projectId: p._id, projectName: p.name, unblocked: next.get(p._id)!.n, first: next.get(p._id)!.first }));
}

/**
 * For a project page, which already holds the project, its State, its open tasks and the member names: the workers on
 * it (not off) and whether it could be running and isn't. One read of its own (the presence rows), plus the daemon's
 * list or open Needs only when there are such rows.
 */
export async function projectRoster(
  s: Scope,
  project: { id: string; name: string; status: string },
  state: { next: { text: string; ref?: number; waitsOn?: string }[] } | null,
  names: Record<string, string>,
  openTasks: { ref: number; status: string }[],
): Promise<{ workers: WorkerRow[]; couldBeRunning: CouldBeRunning | null }> {
  const raw = await loadRaw(s, LIST_HOURS, project.id);
  const live = new Set(openTasks.filter(t => t.status !== 'Blocked').map(t => t.ref));
  const lines = (state?.next ?? []).filter(l => !l.waitsOn && !(l.ref && !live.has(l.ref)));
  const needs = raw.length ? await openNeedRows(s, raw.map(r => r.row)) : new Set<string>();
  const tasks = await taskInfo(s, raw.flatMap(r => (r.row.doing ? [r.row.doing.taskId] : [])));
  const workers = buildWorkers(s, raw, { tasks, names, pname: new Map([[project.id, project.name]]), needs, nextCount: () => lines.length }).filter(w => w.state !== 'off');
  const now = Date.now();
  const anyLive = raw.some(r => workerState(r.row, { now, daemon: r.daemon }) !== 'off');
  return { workers, couldBeRunning: project.status === 'active' && lines.length && !anyLive ? { projectId: project.id, projectName: project.name, unblocked: lines.length, first: lines[0].text.slice(0, 160) } : null };
}
