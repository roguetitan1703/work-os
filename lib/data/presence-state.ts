import type { PresenceState } from '../db';

// The one function that says what state a session is in (docs/flows/agent-system.md section 11; plan H6 D4).
// Pure: no database, no server-only import, so tests and the client can use it. The roster (lib/data/roster.ts
// workerState) calls it; list_sessions (H5) and the brief's alsoHere call it too once they are on this branch.
//
// A row that a Claude Code hook reports on has `activity` (state and time of the last event the server accepted):
//   endedAt, activity off, or the worker daemon reporting the process stopped -> off at once
//   a session is alive while the daemon says its process runs, or while something was heard from it in the last 30 minutes:
//   its last hook event, or its last sign of life (lastSeen: a call it made, or the idle wait that refreshes it each minute)
//   working               -> working while its last event is under 10 min old, else idle (alive) or off
//   working, open (tool-start: a Bash or PowerShell call began and has not ended, as far as the hook knows; hook protocol 4)
//                         -> working for up to 2 hours since the event, daemon or not (hooks review H2: a lost end event, or a
//                            subagent's call before the gate, must not keep a session working for ever); after that the rules above apply. Any later event (tool, stop, end, prompt, notify) replaces activity and clears open.
//   waiting at a prompt   -> waiting (why: prompt) while alive, else off
//   on / idle             -> an open Need makes it waiting (why: need); else on / idle while alive, else off
// A row with no `activity` (claude.ai chat, API, an old hook, a WORK_OS_KEY hook) keeps the call-based rules:
//   off after 30 quiet minutes unless the daemon says it runs; an open Need -> waiting; seen in the last 10 minutes
//   -> working, else idle.

export const WORKING_MIN = 10;
export const GONE_MIN = 30;
/** How long a running tool (activity.open) keeps a session working, whatever the daemon says. */
export const OPEN_TOOL_MIN = 120;

/** What the worker daemon's fresh session list says about the process: running, stopped, or nothing known (no fresh list, or not listed). */
export type DaemonSays = 'running' | 'stopped' | 'unknown';

export type StateRow = {
  lastSeen: Date;
  activity?: { state: PresenceState; at: Date; why?: 'prompt'; open?: boolean } | null;
  endedAt?: Date | null;
};

export type StateResult = { state: PresenceState; /** Only for waiting. */ why?: 'need' | 'prompt'; /** When the state began: activity.at, else lastSeen. */ since: Date };

export function presenceState(row: StateRow, o: { now: number; daemon?: DaemonSays; needs?: boolean }): StateResult {
  const daemon = o.daemon ?? 'unknown';
  const a = row.activity ?? null;
  const since = a ? a.at : row.lastSeen;
  if (row.endedAt || a?.state === 'off' || daemon === 'stopped') return { state: 'off', since };
  if (!a) {
    const ageMin = (o.now - row.lastSeen.getTime()) / 60_000;
    if (ageMin > GONE_MIN && daemon !== 'running') return { state: 'off', since };
    if (o.needs) return { state: 'waiting', why: 'need', since };
    return { state: ageMin <= WORKING_MIN ? 'working' : 'idle', since };
  }
  const ageMin = (o.now - a.at.getTime()) / 60_000;
  const quietMin = (o.now - Math.max(a.at.getTime(), row.lastSeen.getTime())) / 60_000;
  const alive = daemon === 'running' || quietMin <= GONE_MIN;
  if (a.state === 'waiting') return alive ? { state: 'waiting', why: a.why === 'prompt' ? 'prompt' : 'need', since } : { state: 'off', since };
  if (a.state === 'working') {
    if (ageMin <= WORKING_MIN) return { state: 'working', since };
    if (a.open && ageMin <= OPEN_TOOL_MIN) return { state: 'working', since };
    return alive ? { state: 'idle', since } : { state: 'off', since };
  }
  if (!alive) return { state: 'off', since };
  if (o.needs) return { state: 'waiting', why: 'need', since };
  return { state: a.state === 'on' ? 'on' : 'idle', since };
}

/** What the hook reports (POST /api/agent/event). The server decides the state from the event; the hook never sends one. */
export const EVENT_NAMES = ['prompt', 'tool', 'tool-start', 'notify', 'stop', 'end', 'result'] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export const EVENT_KINDS = ['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'auth_success', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The state an event puts a session in, or null for an event that changes nothing (other notification kinds). */
export function eventState(ev: { event: EventName; kind?: EventKind }): { state: PresenceState; why?: 'prompt' } | null {
  switch (ev.event) {
    case 'prompt':
    case 'tool':
    case 'tool-start': // a Bash or PowerShell call began: working, and recordEvent marks it open (a long call sends no event until it ends)
      return { state: 'working' };
    case 'stop':
      return { state: 'idle' };
    case 'end':
      return { state: 'off' };
    case 'result': // a subagent's last message (Lanes step 3): the lane result only, never a state or a sign of life
      return null;
    case 'notify':
      if (ev.kind === 'permission_prompt' || ev.kind === 'elicitation_dialog') return { state: 'waiting', why: 'prompt' };
      if (ev.kind === 'idle_prompt') return { state: 'idle' };
      return null;
  }
}
