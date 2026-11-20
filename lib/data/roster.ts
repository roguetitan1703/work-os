import 'server-only';
import { createHash } from 'node:crypto';
import type { PresenceDoc, PresenceState, StateLine } from '../db';
import { orgWide, scoped, type Scope } from '../scope';
import { memberNames } from '../people';
import { presenceState, isQuiet, lastActive, WORKING_MIN, GONE_MIN, type DaemonSays } from './presence-state';
import { lineHolder } from './lanes';
import { shortAddress } from './presence';
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
  /** The session's short address (lib/data/presence.ts shortAddress): shown for every row, since it never shows the session id. */
  address: string;
  person: string;
  mine: boolean;
  ai: string;
  /** Where it runs, as its hook says: desktop, vscode or terminal ('' when no hook said). */
  tool: string;
  model: string;
  account: string;
  machine: string;
  /** Null: a session outside any project ("No project"); its row is private to its person. */
  project: { id: string; name: string } | null;
  branch: string;
  label: string;
  slot: string;
  doing: { ref: number; title: string; /** false when the worker is off: nobody holds the task */ held: boolean } | null;
  state: WorkerState;
  /** For a waiting worker: an open Need, or (own sessions only) a permission prompt in its terminal. */
  waitingOn?: 'need' | 'prompt' | 'question';
  /** Own rows only, waiting with why question: the question its turn ended with (written by the agent, never checked). */
  ask?: string;
  /** When the state began (the hook's last event, else the last call). */
  since: string;
  /** The last prompt, tool use or turn end (presence-state.ts lastActive); never a resume or the idle wait. '' when none is known. */
  lastActive: string;
  /** Idle with no activity for over 2 hours (presence-state.ts isQuiet): left out of the default Sessions list. */
  quiet: boolean;
  /** Subagents running for it: the worker daemon's count, or its builders that work (shown under it), whichever is more. */
  subagents: number;
  /** For an idle worker: how many unblocked Next lines its project has. */
  nextWork: number;
  lastSeen: string;
  /** 0, or 1 for a builder shown under its orchestrator. */
  depth: 0 | 1;
  /** What the session last reported (a subagent's final message), cut to 300 characters. Only on a project's own roster; written by that agent, never checked. */
  lastResult?: { text: string; at: string };
  /** A builder's orchestrator session id: only on the viewer's own rows (another person's session ids are not shown). */
  parent?: string;
  /** The viewer's own rows only: Claude Code's session id, which names the same session in the computer's own list (claude-overview.ts), so the two lists merge into one (lib/session-item.ts). */
  cc?: string;
};

export type CouldBeRunning = { projectId: string; projectName: string; unblocked: number; first: string };
export type Roster = { workers: WorkerRow[]; couldBeRunning: CouldBeRunning[]; machines: { machine: string; held: number; cap: number }[] };

type Raw = { row: PresenceDoc; daemon: DaemonSays; /** Subagents the daemon counts for its process (0 when it says nothing). */ subagents: number };

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
  const subs = new Map<string, number>();
  if (check.length) {
    // A device counts only for the person who owns it (a session cannot claim someone else's computer).
    const devs = await (await orgWide(s.orgId)).devices.find({ $or: check.map(r => ({ _id: r.machine, ownerId: r.userId })), revokedAt: null }, { projection: { claudeSessions: 1 } }).toArray();
    for (const d of devs) {
      const list = d.claudeSessions;
      if (!list || nowMs - list.at.getTime() > DAEMON_FRESH_MS) continue;
      for (const it of list.items) {
        if (it.unknown) continue; // the computer has no word on it
        says.set(`${d._id}:${it.sessionId}`, it.running ? 'running' : 'stopped');
        if (it.running && it.subagentsActive > 0) subs.set(`${d._id}:${it.sessionId}`, it.subagentsActive);
      }
    }
  }
  return rows.map(row => ({ row, daemon: (ccOf(row) && says.get(`${row.machine}:${ccOf(row)}`)) || 'unknown', subagents: (ccOf(row) && subs.get(`${row.machine}:${ccOf(row)}`)) || 0 }));
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
export const opaqueId = (rowId: string) => createHash('sha256').update(`worker-row:${rowId}`).digest('hex').slice(0, 16);

type Ctx = { results?: boolean; tasks: Map<string, { ref: number; title: string }>; names: Record<string, string>; pname: Map<string, string>; needs: Set<string>; nextCount: (projectId: string) => number };

/** Rows for the screen: state computed, builders placed under their orchestrators, orchestrators ordered working first. */
function buildWorkers(s: Scope, raw: Raw[], x: Ctx): WorkerRow[] {
  const now = Date.now();
  const rows: (WorkerRow & { _parent?: string; _uid: string; _rid: string; _sess: string | null })[] = raw
    .filter(r => r.row.projectId === null || x.pname.has(r.row.projectId))
    .map(({ row, daemon, subagents }) => {
      const st = presenceState(row, { now, daemon, needs: x.needs.has(row._id) });
      const state = st.state;
      const mine = row.userId === s.userId;
      return {
        // Another person's session id never leaves the server: their row gets an opaque id and no session.
        id: mine ? row._id : opaqueId(row._id),
        session: mine ? (row.session ?? null) : null,
        address: shortAddress(row),
        person: x.names[row.userId] || 'a member',
        mine,
        ai: mine ? row.ai : clientWord(row.agent), // a key name is its owner's label: others see the kind of client
        tool: row.tool ?? '',
        model: row.model ?? '',
        account: row.account ?? '',
        machine: row.machineName ?? row.machine,
        project: row.projectId ? { id: row.projectId, name: x.pname.get(row.projectId)! } : null,
        branch: row.branch ?? '',
        label: row.label,
        slot: row.slot ?? '',
        doing: row.doing && x.tasks.get(row.doing.taskId) ? { ...x.tasks.get(row.doing.taskId)!, held: state !== 'off' } : null,
        state,
        // A permission prompt is the owner's business; teammates see only that it waits on a person.
        ...(state === 'waiting' ? { waitingOn: (st.why === 'prompt' || st.why === 'question') && !mine ? ('need' as const) : st.why } : {}),
        ...(state === 'waiting' && st.why === 'question' && mine && row.activity?.ask ? { ask: row.activity.ask } : {}),
        since: st.since.toISOString(),
        lastActive: lastActive(row).getTime() > 0 ? lastActive(row).toISOString() : '', // '' : a hook row that never did anything we know of
        quiet: isQuiet(state, row, now),
        subagents: state === 'off' ? 0 : subagents,
        nextWork: state === 'idle' && row.projectId ? x.nextCount(row.projectId) : 0,
        lastSeen: row.lastSeen.toISOString(),
        ...(x.results && mine && row.lastResult?.text ? { lastResult: { text: row.lastResult.text.slice(0, 300), at: row.lastResult.at.toISOString() } } : {}),
        depth: 0 as const,
        ...(row.userId === s.userId && row.parent ? { parent: row.parent } : {}),
        ...(mine && (row.ccSession ?? row.session) ? { cc: row.ccSession ?? row.session } : {}),
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
    const ks = (kids.get(t._rid) ?? []).sort(cmp);
    // A lead whose builders work has its subagents running, whether or not the daemon counted them.
    const busy = t.state === 'off' ? 0 : ks.filter(k => k.state === 'working').length;
    const subagents = Math.max(t.subagents, busy);
    workers.push(strip({ ...t, subagents, quiet: t.quiet && subagents === 0 }, 0));
    for (const k of ks) workers.push(strip(k, 1));
  }
  return workers;
}

/**
 * The roster the viewer may see: workers, builders under their orchestrators, and the projects that could be running and are not.
 * `results`: each worker's last reported result too (the Claude page's Sessions list). `lite`: workers only, no idle Next
 * counts, could-run list or heavy slots (Today's Claude card counts them and needs nothing else).
 */
export async function roster(s: Scope, opts: { results?: boolean; lite?: boolean } = {}): Promise<Roster> {
  const raw = await loadRaw(s, LIST_HOURS);
  if (opts.lite) {
    if (!raw.length) return { workers: [], couldBeRunning: [], machines: [] };
    const c = await scoped(s);
    const projectIds = [...new Set(raw.flatMap(r => (r.row.projectId ? [r.row.projectId] : [])))];
    const [names, projects, needs, tasks] = await Promise.all([
      memberNames(s.orgId),
      projectIds.length ? c.projects.find({ _id: { $in: projectIds } }, { projection: { name: 1 } }).toArray() : Promise.resolve([]),
      openNeedRows(s, raw.map(r => r.row)),
      taskInfo(s, raw.flatMap(r => (r.row.doing ? [r.row.doing.taskId] : []))),
    ]);
    const pname = new Map(projects.map(p => [p._id, p.name]));
    return { workers: buildWorkers(s, raw, { results: opts.results, tasks, names, pname, needs, nextCount: () => 0 }), couldBeRunning: [], machines: [] };
  }
  const c = await scoped(s);
  const names = await memberNames(s.orgId);
  const projectIds = [...new Set(raw.flatMap(r => (r.row.projectId ? [r.row.projectId] : [])))];
  const projects = projectIds.length ? await c.projects.find({ _id: { $in: projectIds } }, { projection: { name: 1 } }).toArray() : [];
  const pname = new Map(projects.map(p => [p._id, p.name]));
  const needs = await openNeedRows(s, raw.map(r => r.row));
  const nextByProject = await unblockedNext(s, projectIds);
  const tasks = await taskInfo(s, raw.flatMap(r => (r.row.doing ? [r.row.doing.taskId] : [])));
  const workers = buildWorkers(s, raw, { results: opts.results, tasks, names, pname, needs, nextCount: id => nextByProject.get(id)?.n ?? 0 });

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
 * it (off ones too, for "Finished today") and whether it could be running and isn't. One read of its own (the presence rows), plus the daemon's
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
  // Off workers stay in: the page lists live sessions first and those that ended today under "Finished today".
  const workers = buildWorkers(s, raw, { results: true, tasks, names, pname: new Map([[project.id, project.name]]), needs, nextCount: () => lines.length });
  const now = Date.now();
  const anyLive = raw.some(r => workerState(r.row, { now, daemon: r.daemon }) !== 'off');
  return { workers, couldBeRunning: project.status === 'active' && lines.length && !anyLive ? { projectId: project.id, projectName: project.name, unblocked: lines.length, first: lines[0].text.slice(0, 160) } : null };
}

/**
 * Lanes marks for a project's State card: the Now holder's state word and the label of the session that holds each Next or
 * Later line (a hold, or a live session on the line's task by set_doing). Labels only, never a session id. One read of the
 * project's presence rows; nothing when the State has no holder and no held line.
 */
export async function withLaneMarks<T extends { now: { holder?: string; holderState?: string } | null; next: { id: string; ref?: number; holder?: string }[]; later: { id: string; holder?: string }[] }>(
  s: Scope,
  projectId: string,
  doc: { now?: { hold?: { key: string } } | null; next: StateLine[]; later: StateLine[] } | null,
  out: T,
): Promise<T> {
  if (!doc) return out;
  const lines = [...doc.next, ...doc.later];
  const nowKey = doc.now?.hold?.key;
  if (!nowKey && !lines.some(l => l.hold || l.ref != null)) return out;
  const c = await scoped(s);
  const rows = await c.presence.find({ projectId, lastSeen: { $gt: new Date(Date.now() - LIST_HOURS * 3_600_000) } }).limit(300).toArray();
  if (!rows.length) return out;
  const tasks = await taskInfo(s, rows.flatMap(r => (r.doing ? [r.doing.taskId] : [])));
  const now = Date.now();
  const live = rows.map(r => ({ ...r, key: `${r.userId}:${r.key}`, ref: r.doing ? tasks.get(r.doing.taskId)?.ref : undefined }));
  const word = (r: (typeof live)[number]) => {
    const st = presenceState(r, { now });
    return isQuiet(st.state, r, now) ? 'quiet' : st.state;
  };
  const holder = (l: StateLine) => {
    const r = lineHolder(l, live, x => x.ref, now);
    return r ? r.label : undefined;
  };
  const mark = <L extends { id: string; holder?: string }>(list: L[], src: StateLine[]): L[] =>
    list.map(l => {
      const h = holder(src.find(x => x.id === l.id)!);
      return h ? { ...l, holder: h } : l;
    });
  const nowRow = nowKey ? live.find(r => r.key === nowKey) : undefined;
  return {
    ...out,
    now: out.now && nowRow ? { ...out.now, holder: out.now.holder ?? nowRow.label, holderState: word(nowRow) } : out.now,
    next: mark(out.next, doc.next),
    later: mark(out.later, doc.later),
  };
}
