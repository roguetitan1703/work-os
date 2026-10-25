'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { flushQueuedAlerts } from '@/lib/alerts';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { requireCaller, withCaller } from '@/lib/caller';
import { userActor, type Actor } from '@/lib/actors';
import type { Scope } from '@/lib/scope';
import * as tasks from '@/lib/data/tasks';
import * as projects from '@/lib/data/projects';
import { InputError, NotFoundError } from '@/lib/data/errors';
import type {
  Activity,
  Project,
  ProjectInput,
  Status,
  Task,
  TaskInput,
  TaskPatch,
} from '@/lib/types';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Every action here: a signed-in caller (lib/caller.ts), acting in their scope as themselves (actor kind 'user'). */
async function run<T>(fn: (s: Scope, me: Actor) => Promise<T>): Promise<Result<T>> {
  try {
    const caller = await requireCaller();
    const s: Scope = { userId: caller.userId, orgId: caller.orgId };
    const data = await withCaller(caller, () => fn(s, userActor(caller.userId)));
    revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

// ── Tasks (actor: the signed-in person) ─────────────────────────────────────

export async function createTaskAction(input: TaskInput): Promise<Result<Task>> {
  await flushAlerts(); // a task made with an assignee tells them at once
  return run((s, me) => tasks.createTask(s, input, me));
}

export async function bulkCreateTasksAction(inputs: TaskInput[]): Promise<Result<Task[]>> {
  return run((s, me) => tasks.bulkCreateTasks(s, inputs, me));
}

async function flushAlerts() {
  const caller = await requireCaller().catch(() => null);
  if (!caller) return;
  const s: Scope = { userId: caller.userId, orgId: caller.orgId };
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const base = (process.env.APP_URL || (host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : '')).replace(/\/+$/, '');
  after(() => flushQueuedAlerts(s, base));
}

export async function updateTaskAction(id: string, patch: TaskPatch, note?: string): Promise<Result<Task>> {
  await flushAlerts();
  return run((s, me) => tasks.updateTask(s, id, patch, me, { note }));
}

export async function logProgressAction(id: string, progress: number, note?: string, status?: Status): Promise<Result<Task>> {
  await flushAlerts();
  return run((s, me) => tasks.logProgress(s, id, progress, note, me, status));
}

export async function completeTaskAction(id: string, note?: string): Promise<Result<Task>> {
  await flushAlerts();
  return run((s, me) => tasks.completeTask(s, id, note, me));
}

export async function addCommentAction(id: string, note: string): Promise<Result<Task>> {
  return run((s, me) => tasks.addComment(s, id, note, me));
}

export async function setArchivedAction(id: string, archived: boolean): Promise<Result<Task>> {
  return run((s, me) => tasks.setArchived(s, id, archived, me));
}

export async function checklistAction(id: string, ops: tasks.ChecklistOps): Promise<Result<Task>> {
  return run((s, me) => tasks.updateChecklist(s, id, ops, me));
}

// ── Trash (delete / restore) and comment edits ─────────────────────────────
// run() revalidates the whole layout, which covers the task page, /review, /today,
// /tasks and project pages.

export async function deleteTaskAction(ref: number | string, reason?: string): Promise<Result<{ ref: number; title: string }>> {
  await flushAlerts();
  return run((s, me) => tasks.trashTask(s, ref, me, { reason }));
}

export async function restoreTaskAction(ref: number | string): Promise<Result<Task>> {
  return run((s, me) => tasks.restoreTask(s, ref, me));
}

export async function purgeTrashItemAction(ref: number): Promise<Result<number>> {
  return run(async s => {
    const n = await tasks.purgeTrash(s, ref);
    if (!n) throw new NotFoundError(`#${ref} is not in the trash`);
    return n;
  });
}

export async function editCommentAction(activityId: string, text: string): Promise<Result<Activity>> {
  return run((s, me) => tasks.editComment(s, activityId, text, me));
}

export async function deleteCommentAction(activityId: string): Promise<Result<{ taskRef: number }>> {
  return run((s, me) => tasks.deleteComment(s, activityId, me));
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function createProjectAction(input: ProjectInput): Promise<Result<{ project: Project; created: boolean }>> {
  return run(s => projects.createProject(s, input));
}

export async function projectSharingImpactAction(id: string): Promise<Result<{ assignees: string[]; commenters: string[]; claude: string[]; waiting: string[] }>> {
  try {
    const caller = await requireCaller();
    return { ok: true, data: await withCaller(caller, () => projects.projectSharingImpact({ userId: caller.userId, orgId: caller.orgId }, id)) };
  } catch (err) {
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    if (err instanceof SafeError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateProjectAction(id: string, patch: Partial<ProjectInput>): Promise<Result<Project>> {
  return run(s => projects.updateProject(s, id, patch));
}

// ── Session ─────────────────────────────────────────────────────────────────

export async function logoutAction(): Promise<void> {
  // Ends this session in the database and clears its cookies (nextCookies plugin).
  await (await getAuth()).api.signOut({ headers: await headers() }).catch(() => {});
  redirect('/login');
}
