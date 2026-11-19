import 'server-only';
import type { PresenceDoc, StateDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { NotFoundError } from './errors';
import { dueFor } from './declutter';
import { nudgeEntry, nudgeTimeOk, nudgeText, type NudgeRow } from '../nudges-core';
import { lineHolder } from './lanes';
import { memberNames } from '../people';
import { holdKeyOf, stateOfProject } from './states';

// Nudges (note ce434ed759): Work OS asks a session that has work it can see to carry on, or to declutter. Three of them:
//   the turn-end check  the Stop hook, when the last message asks the person something and Next has lines that wait on nobody
//   the idle nudge      the idle wait wakes a session idle 20 minutes (app/api/agent/wait)
//   the Declutter nudge the Stop hook, the Now holder, once a day, when a turn changed no files
// This file is the database half (the holds, the lines, the claim of a nudge, the project's switch); the pure rules and the
// texts are in lib/nudges-core.ts. A project's switch is `nudges: false` on the project (the app only; an agent cannot set it).
// Everything is read through the token owner's door on the token's own project and session.

const LINES_MAX = 3;

/** What a session holds in a project's State: Now, a Next or Later line (hold), or a task (set_doing). */
export function holdsOf(state: StateDoc, row: Pick<PresenceDoc, 'userId' | 'key' | 'doing'>): { now: boolean; line: boolean; doing: boolean } {
  const me = holdKeyOf(row.userId, row.key);
  return {
    now: !!me && state.now?.hold?.key === me,
    line: !!me && [...state.next, ...state.later].some(l => l.hold?.key === me),
    doing: !!row.doing,
  };
}

/**
 * Next lines that wait on nobody (no waits_on) and are not held by another session (a line this session holds, or nobody does, counts),
 * up to 3, each as nudgeEntry words: a line another person or their agent wrote carries its author and a short quote. Their words are
 * other people's: cleaned like a message line.
 */
export async function freeLines(s: Scope, state: Pick<StateDoc, 'next'>, row: Pick<PresenceDoc, 'userId' | 'key' | 'projectId'>): Promise<string[]> {
  const me = holdKeyOf(row.userId, row.key);
  const cands = state.next.filter(l => !l.waitsOn);
  if (!cands.length) return [];
  const live = (await (await scoped(s)).presence.find({ projectId: row.projectId } as never).toArray()).map(r => ({ ...r, key: `${r.userId}:${r.key}` }));
  const now = Date.now();
  const free = cands.filter(l => {
    if (!l.hold) return true;
    const h = lineHolder(l, live, () => undefined, now);
    return !h || h.key === me;
  }).slice(0, LINES_MAX);
  if (!free.length) return [];
  const names = free.some(l => l.by !== row.userId) ? await memberNames(s.orgId) : {};
  return free.map(l => nudgeEntry(l, l.by === row.userId ? undefined : { by: names[l.by] || 'a former member', agent: !!l.src }));
}

/** Is this project's nudging on? (A missing project is off.) */
async function projectOf(s: Scope, projectId: string) {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId });
  return p && p.nudges !== false ? p : null;
}

export async function getNudges(s: Scope, projectId: string): Promise<boolean> {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { nudges: 1 } });
  if (!p) throw new NotFoundError('Project not found');
  return p.nudges !== false;
}

/** The app's switch (the server action only; no MCP tool and no project patch takes it). On = the field is removed. */
export async function setNudges(s: Scope, projectId: string, on: boolean): Promise<boolean> {
  const c = await scoped(s);
  const r = await c.projects.updateOne({ _id: projectId }, on ? { $unset: { nudges: '' }, $set: { updatedAt: new Date() } } : { $set: { nudges: false, updatedAt: new Date() } });
  if (!r.matchedCount) throw new NotFoundError('Project not found');
  return on;
}

/** The Declutter nudge text for the due reasons (counts first, in plain words). */
export function declutterNudge(reasons: string[]): string {
  const parts = reasons.map(r => {
    const m = /^(Later|Next) (\d+) \(over \d+\)$/.exec(r);
    if (m) return `${m[2]} ${m[1]} lines`;
    return r.replace(/^(\d+) notes share a title$/, '$1 notes with the same title');
  });
  return `Work OS: this project's State has ${parts.join(', ')} (Declutter is due). Call declutter: it proposes, your person approves on one Need.`;
}

export type StopNudge = { /** Next lines that wait on nobody (only when the hook said the last message asked something and this session holds work). */ lines?: string[]; /** The Declutter nudge text (only when asked, the Now holder, and due). */ declutter?: string };

/**
 * The Stop hook's part of the nudges, for the token's own session only. `asks`: the turn's last message asked the person something
 * (the hook decided that from the message, which never reaches the server). `quiet`: the turn changed no files and the hook has
 * not nudged about Declutter today. Returns what the hook may use, or null when the project switched nudges off.
 */
export async function stopNudge(s: Scope, row: PresenceDoc, projectId: string | null, q: { asks?: boolean; quiet?: boolean }): Promise<StopNudge | null> {
  if (!projectId || row.dispatched || (!q.asks && !q.quiet)) return null;
  const project = await projectOf(s, projectId);
  if (!project) return null;
  const state = await stateOfProject(s, projectId);
  if (!state) return null;
  const h = holdsOf(state, row);
  const out: StopNudge = {};
  if (q.asks && (h.now || h.line || h.doing)) {
    const lines = await freeLines(s, state, row);
    if (lines.length) out.lines = lines;
  }
  if (q.quiet && h.now) {
    const d = await dueFor(s, project, state);
    if (d.due) out.declutter = declutterNudge(d.reasons);
  }
  return out;
}

/**
 * The idle nudge for a waiting session: the text to wake it with, or null. Everything but the clock is checked here (the clock is
 * lib/nudges-core.ts nudgeTimeOk): a main session of a project (not dispatched), the project's switch, a session that holds Now, a line
 * or a task, and at least one Next line that waits on nobody. The nudge is claimed on the row first (a second waiter or a retry does not send it twice).
 */
export async function idleNudge(s: Scope, row: PresenceDoc, projectId: string | null, now: number = Date.now()): Promise<string | null> {
  if (!projectId || row.dispatched) return null;
  const t = nudgeTimeOk(row as NudgeRow, now);
  if (!t.ok) return null;
  const project = await projectOf(s, projectId);
  if (!project) return null;
  const state = await stateOfProject(s, projectId);
  if (!state) return null;
  const h = holdsOf(state, row);
  if (!h.now && !h.line && !h.doing) return null;
  const lines = await freeLines(s, state, row);
  if (!lines.length) return null;
  const c = await scoped(s);
  const got = await c.presence.updateOne(
    { _id: row._id, userId: s.userId, ...(row.nudgeAt ? { nudgeAt: row.nudgeAt } : { nudgeAt: { $exists: false } }) } as never,
    { $set: { nudgeAt: new Date(now), nudgeDay: t.day, nudgeCount: t.count + 1 } },
  );
  if (!got.matchedCount) return null;
  return nudgeText(t.idleMin, lines);
}
