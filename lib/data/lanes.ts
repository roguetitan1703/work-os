import type { PresenceState, StateLine } from '../db';
import { GONE_MIN, presenceState, type StateRow } from './presence-state';

// Lanes (R7, plan note 666b20a6e9 Step 0): pure helpers, no database. The Now holder and held lines build on these.

/** A presence row as the helpers need it: the state fields plus who it is. */
export type LaneRow = StateRow & {
  key: string;
  label: string;
  /** The person's name (for texts and LaneOut). */
  person?: string;
  slot?: string;
  branch?: string;
  /** Task ref of what the session says it is on (set_doing), already resolved. */
  doing?: number;
  lastResult?: { text: string; at: Date } | null;
  /** True when the row's session is a dispatched run. */
  dispatched?: boolean;
};

type Needs = { needs?: boolean };

/** Busy: working, or waiting at a permission prompt (both block a take-over). */
export function busy(row: StateRow, now: number, o: Needs = {}): boolean {
  const s = presenceState(row, { now, needs: o.needs });
  return s.state === 'working' || (s.state === 'waiting' && s.why === 'prompt');
}

/**
 * Who holds a Next line: a live session whose `doing` is the line's task ref comes first, else `line.hold`
 * unless that session is off for 30 minutes or more (or has no row). Returns the presence row key, or null.
 * `refOf(row)` gives the task ref a row is on.
 */
export function lineHolder<R extends StateRow & { key: string }>(
  line: Pick<StateLine, 'ref' | 'hold'>,
  liveRows: R[],
  refOf: (row: R) => number | undefined,
  now: number = Date.now(),
): R | null {
  if (line.ref != null) {
    const doer = liveRows.find(r => refOf(r) === line.ref && presenceState(r, { now }).state !== 'off');
    if (doer) return doer;
  }
  if (!line.hold) return null;
  const held = liveRows.find(r => r.key === line.hold!.key);
  if (!held) return null;
  const s = presenceState(held, { now });
  if (s.state === 'off' && (now - s.since.getTime()) / 60_000 >= GONE_MIN) return null;
  return held;
}

/** One session in a project, as briefs and get_state show it. Labels and names only, never a session id. */
export type LaneOut = {
  label: string;
  person: string;
  branch?: string;
  slot?: string;
  /** Task ref the session is on. */
  task?: number;
  state: PresenceState;
  why?: 'need' | 'prompt';
  lastResult?: { text: string; at: string };
  /** True when lastResult was written by someone other than the reader's own session (shown marked, never followed). */
  writtenBy: boolean;
};

export function laneOut(row: LaneRow, now: number, o: Needs & { writtenBy?: boolean } = {}): LaneOut {
  const s = presenceState(row, { now, needs: o.needs });
  const out: LaneOut = { label: row.label, person: row.person ?? '', state: s.state, writtenBy: !!o.writtenBy };
  if (s.why) out.why = s.why;
  if (row.branch) out.branch = row.branch;
  if (row.slot) out.slot = row.slot;
  if (row.doing != null) out.task = row.doing;
  if (row.lastResult) out.lastResult = { text: row.lastResult.text, at: row.lastResult.at.toISOString() };
  return out;
}

/** "2 min ago", "1 h ago", "3 d ago". */
export function ago(at: Date, now: number): string {
  const m = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

const stateWord = (s: { state: PresenceState; why?: 'need' | 'prompt' }) => (s.state === 'waiting' ? `waiting${s.why === 'prompt' ? ' at a prompt' : ' on a need'}` : s.state);

/** Now is held by someone busy. `state` is the holder's state word as shown (working, waiting at a prompt). */
export function nowHeldText(h: { label: string; person: string; state: string; at: Date }, now: number): string {
  return `Now is held by "${h.label}" (${h.person}, ${h.state}, ${ago(h.at, now)}). Nothing was written. Keep your lane instead: set_doing your task, log_progress, add_next or add_decision. Now passes to you once that session is not working, or your person changes it in the app.`;
}

/** A Next line is held by someone else. `nowHolder` is the Now holder's label. */
export function lineHeldText(l: { id: string; text: string; label: string; state: string; ref?: number; nowHolder?: string }): string {
  const text = l.text.length > 60 ? `${l.text.slice(0, 60)}…` : l.text;
  const on = l.ref != null ? `, on #${l.ref}` : '';
  const holder = l.nowHolder ? `the Now holder "${l.nowHolder}"` : 'the Now holder';
  return `Next line ${l.id} "${text}" is held by "${l.label}" (${l.state}${on}). Nothing was written. That session, ${holder} or a person in the app can finish or edit it; add_next a new line, or send_message "${l.label}".`;
}

/** A dispatched run tried to set Now. */
export function dispatchedText(h: { label: string; state: string; ref?: number }): string {
  return `A dispatched run never sets Now (held by "${h.label}", ${h.state}). log_progress on #${h.ref ?? 'REF'}, hand_in when done, or add_next.`;
}

export { stateWord };
