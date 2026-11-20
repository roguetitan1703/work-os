import 'server-only';
import { scoped, type Scope } from '../scope';
import { GONE_MIN, presenceState } from './presence-state';
import { listProjectsNav } from './projects';
import { nowOfProjects } from './states';
import type { StateDoc } from '../db';

/** One row of Today's "Projects now" card. */
export type ProjectNowRow = { id: string; name: string; now: string | null; next: string | null; sessions: number; need: boolean };

export const PROJECTS_NOW_MAX = 5;

/**
 * Today's "Projects now": the projects that have a live session in a lane, a Need waiting on the caller or one of the
 * caller's open tasks, newest need first, then most sessions, at most PROJECTS_NOW_MAX. Three small reads (project names,
 * live presence rows, the Now and first Next of the chosen projects), all through the caller's door, so a project the
 * caller cannot read never appears.
 */
export async function projectsNow(
  s: Scope,
  o: {
    needProjects: string[];
    taskProjects: string[];
    /** States the caller already read (Today's task chips): their Now and first Next are used, and only the other chosen projects are read here. */
    states?: Record<string, Pick<StateDoc, 'now' | 'next'>>;
  },
): Promise<ProjectNowRow[]> {
  const projects = await listProjectsNav(s);
  if (!projects.length) return [];
  const ids = projects.map(p => p.id);
  const now = Date.now();
  const rows = await (await scoped(s)).presence
    .find({ projectId: { $in: ids }, lastSeen: { $gte: new Date(now - GONE_MIN * 60_000) } } as never, { projection: { projectId: 1, lastSeen: 1, activity: 1, endedAt: 1 } })
    .toArray();
  const sessions = new Map<string, number>();
  for (const r of rows) if (r.projectId && presenceState(r, { now }).state !== 'off') sessions.set(r.projectId, (sessions.get(r.projectId) ?? 0) + 1);
  const needs = new Set(o.needProjects);
  const mine = new Set(o.taskProjects);
  const chosen = projects
    .filter(p => sessions.has(p.id) || needs.has(p.id) || mine.has(p.id))
    .sort((a, b) => Number(needs.has(b.id)) - Number(needs.has(a.id)) || (sessions.get(b.id) ?? 0) - (sessions.get(a.id) ?? 0) || a.name.localeCompare(b.name))
    .slice(0, PROJECTS_NOW_MAX);
  if (!chosen.length) return [];
  const have = o.states ?? {};
  const read = await nowOfProjects(s, chosen.map(p => p.id).filter(id => !have[id]));
  const goals: Record<string, { now: string | null; next: string | null }> = { ...read };
  for (const id of Object.keys(have)) goals[id] = { now: have[id].now?.text ?? null, next: have[id].next?.[0]?.text ?? null };
  return chosen.map(p => ({ id: p.id, name: p.name, now: goals[p.id]?.now ?? null, next: goals[p.id]?.next ?? null, sessions: sessions.get(p.id) ?? 0, need: needs.has(p.id) }));
}
