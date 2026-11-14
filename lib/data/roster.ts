import 'server-only';
import type { PresenceDoc } from '../db';
import { orgWide, scoped, type Scope } from '../scope';
import { memberNames } from '../people';
import { openNeedRows } from './roster-needs';
import { slotHolders, machineKey } from './slots';

// The roster (docs/flows/plan-1-3.md slice 7): who is working on what, and where. A worker is a present session
// (presence rows, lib/data/presence.ts, grown with model, account, machine, branch, doing, parent and slot). The rows
// come through the scoped door, so a viewer sees only the workers on projects they can read.
//
// A worker's state is computed on every read, never typed by anyone:
//   working   seen in the last 10 minutes
//   waiting   has an open Need (asked a person something; slice 4, read through roster-needs.ts)
//   idle      seen 10 to 30 minutes ago; "with Next work" when its project's State has unblocked Next lines
//   gone      not seen for 30 minutes and, where the daemon reports, its process is gone. Its task is shown unheld.
// Waiting wins over working (it is why it is quiet); gone wins over everything.

export const WORKING_MIN = 10;
export const GONE_MIN = 30;
/** Workers last seen longer ago than this are not listed at all. */
const LIST_HOURS = 24;
/** A daemon's session list older than this says nothing about whether the process still runs. */
const DAEMON_FRESH_MS = 5 * 60_000;

export type WorkerState = 'working' | 'waiting' | 'idle' | 'gone';

export type WorkerRow = {
  id: string;
  session: string | null;
  person: string;
  mine: boolean;
  ai: string;
  model: string;
  account: string;
  machine: string;
  project: { id: string; name: string };
  branch: string;
  label: string;
  slot: string;
  doing: { ref: number; title: string; /** false when the worker is gone: nobody holds the task */ held: boolean } | null;
  state: WorkerState;
  /** For an idle worker: how many unblocked Next lines its project has. */
  nextWork: number;
  lastSeen: string;
  /** 0, or 1 for a builder shown under its orchestrator. */
  depth: 0 | 1;
};

export type CouldBeRunning = { projectId: string; projectName: string; unblocked: number; first: string };
export type Roster = { workers: WorkerRow[]; couldBeRunning: CouldBeRunning[]; machines: { machine: string; held: number; cap: number }[] };

type Raw = { row: PresenceDoc; running: boolean };

/** Pure: the state of one worker at `now`. `running` = the daemon reports its process alive; `needs` = it has an open Need. */
export function workerState(row: Pick<PresenceDoc, 'lastSeen'>, o: { now: number; running?: boolean; needs?: boolean }): WorkerState {
  const ageMin = (o.now - row.lastSeen.getTime()) / 60_000;
  if (ageMin > GONE_MIN && !o.running) return 'gone';
  if (o.needs) return 'waiting';
  return ageMin <= WORKING_MIN ? 'working' : 'idle';
}

const OPEN_LINE_STATUS: ('Done' | 'Dropped' | 'Blocked')[] = ['Done', 'Dropped', 'Blocked'];

/** Projects of `ids` with unblocked Next lines in their State (no waitsOn; a line pointing at a closed or blocked task does not count). */
async function unblockedNext(s: Scope, ids?: string[]): Promise<Map<string, { n: number; first: string }>> {
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
  const out = new Map<string, { n: number; first: string }>();
  for (const st of states) {
    const live = st.next.filter(l => !l.waitsOn && !(l.ref && closed.has(`${st.projectId}:${l.ref}`)));
    if (live.length) out.set(st.projectId, { n: live.length, first: live[0].text.slice(0, 160) });
  }
  return out;
}

async function loadRaw(s: Scope, hours: number, projectId?: string): Promise<Raw[]> {
  const c = await scoped(s);
  const rows = await c.presence.find({ lastSeen: { $gt: new Date(Date.now() - hours * 3_600_000) }, ...(projectId ? { projectId } : {}) }).sort({ lastSeen: -1 }).limit(300).toArray();
  if (!rows.length) return [];
  // Where the daemon reports, a session whose process still runs is not gone however quiet it is. The daemon belongs to
  // the worker's own person, so it is read for the whole organization (it answers only "running or not").
  // Only rows quiet for over 30 minutes can be saved by it, so a roster of busy workers costs no extra read.
  const machineIds = [...new Set(rows.filter(r => r.session && r.machineName && Date.now() - r.lastSeen.getTime() > GONE_MIN * 60_000).map(r => r.machine))];
  const alive = new Set<string>();
  if (machineIds.length) {
    const devs = await (await orgWide(s.orgId)).devices.find({ _id: { $in: machineIds }, revokedAt: null }, { projection: { claudeSessions: 1 } }).toArray();
    const nowMs = Date.now();
    for (const d of devs) {
      const list = d.claudeSessions;
      if (!list || nowMs - list.at.getTime() > DAEMON_FRESH_MS) continue;
      for (const it of list.items) if (it.running) alive.add(`${d._id}:${it.sessionId}`);
    }
  }
  return rows.map(row => ({ row, running: !!row.session && alive.has(`${row.machine}:${row.session}`) }));
}

type Ctx = { names: Record<string, string>; pname: Map<string, string>; needs: Set<string>; nextCount: (projectId: string) => number };

/** Rows for the screen: state computed, builders placed under their orchestrators, orchestrators ordered working first. */
function buildWorkers(s: Scope, raw: Raw[], x: Ctx): WorkerRow[] {
  const now = Date.now();
  const rows: (WorkerRow & { _parent?: string; _uid: string })[] = raw
    .filter(r => x.pname.has(r.row.projectId))
    .map(({ row, running }) => {
      const state = workerState(row, { now, running, needs: x.needs.has(row._id) });
      return {
        id: row._id,
        session: row.session ?? null,
        person: x.names[row.userId] || 'a member',
        mine: row.userId === s.userId,
        ai: row.ai,
        model: row.model ?? '',
        account: row.account ?? '',
        machine: row.machineName ?? row.machine,
        project: { id: row.projectId, name: x.pname.get(row.projectId)! },
        branch: row.branch ?? '',
        label: row.label,
        slot: row.slot ?? '',
        doing: row.doing ? { ref: row.doing.ref, title: row.doing.title, held: state !== 'gone' } : null,
        state,
        nextWork: state === 'idle' ? x.nextCount(row.projectId) : 0,
        lastSeen: row.lastSeen.toISOString(),
        depth: 0 as const,
        _parent: row.parent,
        _uid: row.userId,
      };
    });
  // Builders under their orchestrator (the one whose session id they named, same person).
  const rank: Record<WorkerState, number> = { working: 0, waiting: 1, idle: 2, gone: 3 };
  const bySession = new Map(rows.filter(r => r.session).map(r => [`${r._uid}:${r.session}`, r]));
  const kids = new Map<string, typeof rows>();
  const tops: typeof rows = [];
  for (const r of rows) {
    const p = r._parent ? bySession.get(`${r._uid}:${r._parent}`) : undefined;
    if (p && p !== r) kids.set(p.id, [...(kids.get(p.id) ?? []), r]);
    else tops.push(r);
  }
  const cmp = (a: WorkerRow, b: WorkerRow) => rank[a.state] - rank[b.state] || b.lastSeen.localeCompare(a.lastSeen);
  const workers: WorkerRow[] = [];
  for (const t of tops.sort(cmp)) {
    workers.push(strip(t, 0));
    for (const k of (kids.get(t.id) ?? []).sort(cmp)) workers.push(strip(k, 1));
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
  const workers = buildWorkers(s, raw, { names, pname, needs, nextCount: id => nextByProject.get(id)?.n ?? 0 });

  const keyOf = (r: PresenceDoc) => machineKey(r.userId, { machine: r.machine, machineName: r.machineName });
  const machineKeys = [...new Set(raw.filter(r => r.row.machine).map(r => keyOf(r.row)))];
  const held = await slotHolders(s, machineKeys);
  const display = new Map(raw.map(r => [keyOf(r.row), r.row.machineName ?? r.row.machine]));
  const machines = [...held].filter(([, v]) => v.held > 0).map(([k, v]) => ({ machine: display.get(k) ?? k, held: v.held, cap: v.cap }));

  return { workers, couldBeRunning: await couldBeRunning(s, raw), machines };
}

function strip(r: WorkerRow & { _parent?: string; _uid?: string }, depth: 0 | 1): WorkerRow {
  const { _parent, _uid, ...rest } = r;
  void _parent;
  void _uid;
  return { ...rest, depth };
}

/**
 * "Could be running and isn't": active projects the caller can read whose State has unblocked Next lines and no live
 * worker (a worker seen in the last 30 minutes, or one whose process the daemon reports). The digest calls this too.
 */
export async function couldBeRunning(s: Scope, loaded?: Raw[]): Promise<CouldBeRunning[]> {
  const c = await scoped(s);
  const next = await unblockedNext(s);
  if (!next.size) return [];
  const raw = loaded ?? (await loadRaw(s, 1));
  const now = Date.now();
  const live = new Set(raw.filter(r => workerState(r.row, { now, running: r.running }) !== 'gone').map(r => r.row.projectId));
  const ids = [...next.keys()].filter(id => !live.has(id));
  if (!ids.length) return [];
  const projects = await c.projects.find({ _id: { $in: ids }, status: 'active' }, { projection: { name: 1, nameLower: 1 } }).sort({ nameLower: 1 }).toArray();
  return projects.map(p => ({ projectId: p._id, projectName: p.name, unblocked: next.get(p._id)!.n, first: next.get(p._id)!.first }));
}

/**
 * For a project page, which already holds the project, its State, its open tasks and the member names: the workers on
 * it (not gone) and whether it could be running and isn't. One read of its own (the presence rows), plus the daemon's
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
  const workers = buildWorkers(s, raw, { names, pname: new Map([[project.id, project.name]]), needs, nextCount: () => lines.length }).filter(w => w.state !== 'gone');
  const now = Date.now();
  const anyLive = raw.some(r => workerState(r.row, { now, running: r.running }) !== 'gone');
  return { workers, couldBeRunning: project.status === 'active' && lines.length && !anyLive ? { projectId: project.id, projectName: project.name, unblocked: lines.length, first: lines[0].text.slice(0, 160) } : null };
}
