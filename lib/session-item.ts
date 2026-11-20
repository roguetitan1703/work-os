// One Claude Code session as every screen shows it (the Claude page, a project page, Today's Claude card, a Need's chip).
// Two sources say what a session is doing: the roster (lib/data/roster.ts: presence rows, every session the viewer may
// see, with its state, task and last result) and the computer's own list (lib/data/claude-overview.ts: the viewer's own
// computers, with what can be done to a session: Open in VS Code, Stop, Resume, Remove, Link). mergeSessions joins them on
// "<device id>:<Claude Code session id>" so one session is one row, then sorts live first and puts the ended ones under
// "Finished today" (ended today in the person's timezone) or "Earlier".
//
// Client-safe and pure (no imports but types): tests/sessions-merge.test.mjs runs it directly.

import type { SessionRow } from './data/claude-overview';
import type { WorkerRow } from './data/roster';

export type SessionState = 'working' | 'waiting' | 'on' | 'idle' | 'starting' | 'off' | 'failed' | 'unknown';

export type SessionItem = {
  /** Unique on the page; `/claude?s=<id>` opens it. Another person's session has an opaque id (roster.ts). */
  id: string;
  /** The roster row id (data-worker), when the roster lists it. */
  worker?: string;
  /** 1 for a builder shown under its orchestrator. */
  depth: 0 | 1;
  label: string;
  /** Who it works for; empty for the viewer's own sessions. */
  person: string;
  personName: string;
  mine: boolean;
  project: { id: string; name: string } | null;
  state: SessionState;
  /** The state in words, for the badge: "Working", "Waiting on you", "Idle", "Off"... */
  word: string;
  /** When it went idle or started waiting (ISO), for "since HH:MM". */
  since?: string;
  /** What it is on: its set_doing task ("#12 title", `ref` set), or the last result its hook reported. `held` false when it is off. */
  doing?: { text: string; ref?: number; held: boolean };
  /** The last result it reported (the main conversation's last message at the end of a turn, cut), written by the agent and never checked. */
  last?: { text: string; at: string };
  /** The client and model ("Claude Code · Opus 4.7"). */
  via: string;
  /** Where it runs (ORIGIN_LABEL): a Work OS dispatched run is 'workos' whatever runs it; unknown or 'other' is left out. */
  origin?: SessionWhere;
  machine: string;
  branch: string;
  account: string;
  slot: string;
  /** For an idle session: unblocked Next lines its project has. */
  nextWork: number;
  lastActiveAt: string;
  /** The computer's own row (the viewer's own sessions): what can be done to it. */
  control?: SessionRow;
};

export type SessionsView = {
  live: SessionItem[];
  /** Ended today in the person's timezone, newest first. */
  finished: SessionItem[];
  /** Ended before today (the computer's own list keeps the last few, with Resume and Remove). */
  earlier: SessionItem[];
  counts: { live: number; working: number; waiting: number; finished: number };
};

const RANK: Record<SessionState, number> = { working: 0, waiting: 1, starting: 2, on: 3, idle: 4, unknown: 5, off: 6, failed: 7 };
const isLive = (s: SessionState) => s !== 'off' && s !== 'failed';

const TOOL_NAME: Record<string, string> = { desktop: 'Desktop', vscode: 'VS Code', terminal: 'Terminal' };

export type SessionWhere = 'desktop' | 'vscode' | 'cli' | 'workos';
/** The meta line's one word on where a session runs. */
export const ORIGIN_LABEL: Record<SessionWhere, string> = { desktop: 'Desktop app', vscode: 'VS Code', cli: 'Terminal', workos: 'Started from Work OS' };
const TOOL_WHERE: Record<string, SessionWhere> = { desktop: 'desktop', vscode: 'vscode', terminal: 'cli', cli: 'cli' };

/** Where a session runs: a dispatched run first, then the computer's list (it knows), then what the session's hook reported. */
function whereOf(c: SessionRow | undefined, tool?: string): SessionWhere | undefined {
  if (c?.dispatched) return 'workos';
  if (c?.origin && c.origin !== 'other') return c.origin;
  return tool ? TOOL_WHERE[tool] : undefined;
}

/** "2026-11-20" for an instant in a timezone (lib/dates.ts dateInTz, repeated here to keep this file import-free). */
function dayIn(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "14:02" in the person's timezone. */
export function clockOf(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
  } catch {
    return '';
  }
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function overviewState(r: SessionRow): SessionState {
  if (r.waiting && r.waitingWhy === 'prompt') return 'waiting';
  switch (r.state) {
    case 'working':
      return 'working';
    case 'open':
      return 'on';
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      return 'off'; // closed, stopped
  }
}

/** The state in words, as the badge says it. */
function wordOf(state: SessionState, o: { mine: boolean; waitingOn?: 'need' | 'prompt'; nextWork?: number; control?: SessionRow }): string {
  const c = o.control;
  if (c?.needsTrust) return `Waiting for you to trust this new repo on ${c.deviceName}`;
  if (c?.cloning && state === 'starting') return `Cloning on ${c.deviceName}…`;
  if (c?.waiting && !c.waitingWhy && state === 'starting') return `Waiting: check the terminal on ${c.deviceName}`;
  switch (state) {
    case 'working':
      return c && c.subagents > 0 ? `Working · ${plural(c.subagents, 'subagent')}` : 'Working';
    case 'waiting':
      return o.waitingOn === 'prompt' && o.mine ? 'Waiting on you' : 'Waiting on a person';
    case 'on':
      return 'On';
    case 'idle':
      return o.nextWork ? `Idle · ${plural(o.nextWork, 'Next line')} waiting` : 'Idle';
    case 'starting':
      return 'Starting';
    case 'failed':
      return 'Failed';
    case 'unknown':
      return 'No news';
    default:
      return c?.state === 'stopped' ? 'Stopped' : 'Off';
  }
}

function fromWorker(w: WorkerRow, c: SessionRow | undefined): SessionItem {
  let state: SessionState = w.state;
  let waitingOn = w.waitingOn;
  // The computer's list knows a permission prompt or a start that is still going when the hook has not said so yet.
  if (c && state !== 'off' && c.waiting && c.waitingWhy === 'prompt') {
    state = 'waiting';
    waitingOn = 'prompt';
  }
  if (c && state !== 'off' && overviewState(c) === 'starting') state = 'starting';
  const via = [TOOL_NAME[w.tool] ?? '', w.ai, w.model].filter(Boolean).join(' · ');
  const last = c?.lastActiveAt && c.lastActiveAt > w.lastSeen ? c.lastActiveAt : w.lastSeen;
  return {
    id: w.id,
    worker: w.id,
    depth: w.depth,
    label: w.label || c?.title || w.ai,
    person: w.mine ? '' : w.person,
    personName: w.person,
    mine: w.mine,
    project: w.project ?? (c?.projectId ? { id: c.projectId, name: c.projectName ?? c.projectId } : null),
    state,
    word: wordOf(state, { mine: w.mine, waitingOn, nextWork: w.nextWork, control: c }),
    ...(state === 'idle' || state === 'waiting' ? { since: w.since } : {}),
    ...(w.doing ? { doing: { text: `#${w.doing.ref} ${w.doing.title}`, ref: w.doing.ref, held: w.doing.held } } : c?.doing ? { doing: { text: c.doing, held: true } } : {}),
    ...(w.lastResult ? { last: w.lastResult } : {}),
    via,
    ...(whereOf(c, w.tool) ? { origin: whereOf(c, w.tool) } : {}),
    machine: c?.deviceName || w.machine, // the computer's own name when its list has the session
    branch: w.branch,
    account: w.account,
    slot: w.slot,
    nextWork: w.nextWork,
    lastActiveAt: last,
    ...(c ? { control: c } : {}),
  };
}

function fromRow(r: SessionRow): SessionItem {
  const state = overviewState(r);
  return {
    id: r.key,
    depth: 0,
    label: r.title,
    person: '',
    personName: '',
    mine: true,
    project: r.projectId ? { id: r.projectId, name: r.projectName ?? r.projectId } : null,
    state,
    word: wordOf(state, { mine: true, waitingOn: r.waitingWhy, control: r }),
    ...(r.doing ? { doing: { text: r.doing, held: true } } : {}),
    via: r.origin === 'vscode' ? 'VS Code' : '',
    ...(whereOf(r) ? { origin: whereOf(r) } : {}),
    machine: r.deviceName,
    branch: '',
    account: '',
    slot: '',
    nextWork: 0,
    lastActiveAt: r.lastActiveAt ?? '',
    control: r,
  };
}

/**
 * One list from both sources. `workers` in roster order (orchestrators with their builders right after them), `rows` the
 * computer's own list. A builder stays with its orchestrator: the group is live while any of it is.
 */
export function mergeSessions(workers: WorkerRow[], rows: SessionRow[], o: { tz: string; now: number; projectId?: string }): SessionsView {
  // A computer row's key is "<device id>:<session id>"; the roster names the session id only (its machine is whatever the
  // session reported), and only on the viewer's own rows, which are the only ones the computer list has.
  const bySession = new Map(rows.map(r => [r.key.slice(r.deviceId.length + 1), r]));
  const used = new Set<string>();
  const groups: SessionItem[][] = [];
  for (const w of workers) {
    const hit = w.cc ? bySession.get(w.cc) : undefined;
    const c = hit && !used.has(hit.key) ? hit : undefined;
    if (c) used.add(c.key);
    const it = fromWorker(w, c);
    if (w.depth === 1 && groups.length) groups[groups.length - 1].push(it);
    else groups.push([it]);
  }
  for (const r of rows) {
    if (used.has(r.key)) continue;
    if (o.projectId && r.projectId !== o.projectId && r.controlProjectId !== o.projectId) continue;
    groups.push([fromRow(r)]);
  }
  const today = dayIn(new Date(o.now).toISOString(), o.tz);
  const rank = (g: SessionItem[]) => Math.min(...g.map(i => RANK[i.state]));
  const newest = (g: SessionItem[]) => g.reduce((m, i) => (i.lastActiveAt > m ? i.lastActiveAt : m), '');
  const live: SessionItem[][] = [];
  const finished: SessionItem[][] = [];
  const earlier: SessionItem[][] = [];
  for (const g of groups) {
    if (g.some(i => isLive(i.state))) live.push(g);
    else if (newest(g) && dayIn(newest(g), o.tz) === today) finished.push(g);
    else earlier.push(g);
  }
  live.sort((a, b) => rank(a) - rank(b) || newest(b).localeCompare(newest(a)));
  finished.sort((a, b) => newest(b).localeCompare(newest(a)));
  earlier.sort((a, b) => newest(b).localeCompare(newest(a)));
  const flat = (l: SessionItem[][]) => l.flat();
  const liveItems = flat(live);
  return {
    live: liveItems,
    finished: flat(finished),
    earlier: flat(earlier),
    counts: {
      live: liveItems.filter(i => isLive(i.state)).length,
      working: liveItems.filter(i => i.state === 'working').length,
      waiting: liveItems.filter(i => i.state === 'waiting').length,
      finished: flat(finished).length,
    },
  };
}

/** The StatusBadge key for a state (components/ui/status-badge.tsx TONES). */
export function badgeOf(s: SessionState, word: string): 'Working' | 'Waiting on you' | 'Waiting on a person' | 'On' | 'Idle' | 'Off' | 'Starting' | 'Failed' | 'No news' {
  switch (s) {
    case 'working':
      return 'Working';
    case 'waiting':
      return word === 'Waiting on you' ? 'Waiting on you' : 'Waiting on a person';
    case 'on':
      return 'On';
    case 'idle':
      return 'Idle';
    case 'starting':
      return word.startsWith('Waiting') ? 'Waiting on you' : 'Starting';
    case 'failed':
      return 'Failed';
    case 'unknown':
      return 'No news';
    default:
      return 'Off';
  }
}
