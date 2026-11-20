import 'server-only';
import type { Scope } from '../scope';
import type { StateDoc } from '../db';
import { stateOfProject } from './states';

/** Why a task exists, in one line, and the goal of its project (its Now) for context. Plain data for both task screens. */
export type TaskPurpose = {
  /** Where the why came from: the project's Now, a Next line, the parent task or the description. */
  kind: 'now' | 'next' | 'parent' | 'description';
  text: string;
} | null;
export type TaskPurposeOut = { why: TaskPurpose; now: string | null; projectId: string | null };

type T = { ref: number; projectId?: string | null; parentRef?: number | null; parentTitle?: string | null; description?: string | null };

// String.raw: in a plain template literal \w and \d lose their backslash, and #12 would match inside #123.
const names = (text: string, ref: number) => new RegExp(String.raw`(^|[^\w#])#${ref}(?!\d)`).test(text);

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
