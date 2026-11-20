import 'server-only';
import type { Scope } from '../scope';
import type { StateDoc } from '../db';
import { stateOfProject, statesOfProjects } from './states';

/** Why a task exists, in one line, and the goal of its project (its Now) for context. Plain data for both task screens. */
export type TaskPurpose = {
  /** Where the why came from: the project's Now, a Next line, the parent task or the description. */
  kind: 'now' | 'next' | 'parent' | 'description';
  text: string;
} | null;
export type TaskPurposeOut = { why: TaskPurpose; now: string | null; projectId: string | null };

type T = { ref: number; projectId?: string | null; parentRef?: number | null; parentTitle?: string | null; description?: string | null };

// String.raw: in a plain template literal \w and \d lose their backslash, and #12 would match inside #123.
export const names = (text: string, ref: number) => new RegExp(String.raw`(^|[^\w#])#${ref}(?!\d)`).test(text);

/** The Next line a task serves, as "Next 2: text" (matched by ref, or by the #ref in the text), or null. */
export function nextServing(ref: number, state: Pick<StateDoc, 'next'> | null): string | null {
  const i = state?.next.findIndex(l => l.ref === ref || names(l.text, ref)) ?? -1;
  return state && i >= 0 ? `Next ${i + 1}: ${state.next[i].text}` : null;
}

/**
 * The task's why, first match wins: the project's Now names its #ref; a Next line carries its ref (or names it); the parent
 * task; the description's first line. `state` is the project's State (already read through the caller's door), or null.
 */
export function purposeOf(task: T, state: Pick<StateDoc, 'now' | 'next'> | null): TaskPurposeOut {
  const now = state?.now?.text ?? null;
  const base = { now, projectId: task.projectId ?? null };
  if (now && names(now, task.ref)) return { ...base, why: { kind: 'now', text: "This is the project's Now" } };
  const i = state?.next.findIndex(l => l.ref === task.ref || names(l.text, task.ref)) ?? -1;
  if (state && i >= 0) return { ...base, why: { kind: 'next', text: `Next ${i + 1}: ${state.next[i].text}` } };
  if (task.parentRef) return { ...base, why: { kind: 'parent', text: `Part of #${task.parentRef}${task.parentTitle ? ` ${task.parentTitle}` : ''}` } };
  const first = (task.description ?? '').split('\n').map(l => l.trim()).find(Boolean);
  return { ...base, why: first ? { kind: 'description', text: first } : null };
}

/** purposeOf for a task page: one State read (the caller's door hides a project they cannot read), none without a project. */
export async function purposeForTask(s: Scope, task: T): Promise<TaskPurposeOut> {
  const state = task.projectId ? await stateOfProject(s, task.projectId) : null;
  return purposeOf(task, state);
}

/** Where a task sits in its project's State: the Now names it, a Next line carries it (n = its place), or a Later line names it. */
export type TaskPlace = { kind: 'now' | 'next' | 'later'; label: string } | null;

const hits = (l: { text: string; ref?: number }, ref: number) => l.ref === ref || names(l.text, ref);

export function placeOf(ref: number, state: Pick<StateDoc, 'now' | 'next' | 'later'> | null): TaskPlace {
  if (!state) return null;
  if (state.now && names(state.now.text, ref)) return { kind: 'now', label: 'Now' };
  const i = state.next.findIndex(l => hits(l, ref));
  if (i >= 0) return { kind: 'next', label: `Next ${i + 1}` };
  if (state.later.some(l => hits(l, ref))) return { kind: 'later', label: 'Later' };
  return null;
}

/** The chips for many task rows: one batched State read for the projects shown (through the caller's door), none per row. */
export async function placesOfTasks(
  s: Scope,
  tasks: { id: string; ref: number; projectId?: string | null }[],
  /** States the caller already read (Today shares one read with its Projects card); read here when left out. */
  loaded?: Record<string, Pick<StateDoc, 'now' | 'next' | 'later'>>,
): Promise<Record<string, NonNullable<TaskPlace>>> {
  const ids = [...new Set(tasks.map(t => t.projectId).filter((x): x is string => !!x))];
  const states = loaded ?? (await statesOfProjects(s, ids));
  const out: Record<string, NonNullable<TaskPlace>> = {};
  for (const t of tasks) {
    const p = t.projectId ? placeOf(t.ref, states[t.projectId] ?? null) : null;
    if (p) out[t.id] = p;
  }
  return out;
}
