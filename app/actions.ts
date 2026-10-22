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
import * as tasks from '@/lib/data/tasks';
import * as projects from '@/lib/data/projects';
import * as reviews from '@/lib/data/reviews';
import { InputError, NotFoundError } from '@/lib/data/errors';
import type {
  Activity,
  FiverrRitualLog,
  Project,
  ProjectInput,
  Status,
  Task,
  TaskInput,
  TaskPatch,
  WeeklyReview,
} from '@/lib/types';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Every action here: a signed-in caller (lib/caller.ts), whose user id goes on the history entries it writes. */
async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const caller = await requireCaller();
    const data = await withCaller(caller, fn);
    revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

// ── Tasks (actor: me) ───────────────────────────────────────────────────────

export async function createTaskAction(input: TaskInput): Promise<Result<Task>> {
  return run(() => tasks.createTask(input, 'me'));
}

export async function bulkCreateTasksAction(inputs: TaskInput[]): Promise<Result<Task[]>> {
  return run(() => tasks.bulkCreateTasks(inputs, 'me'));
}

async function flushAlerts() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const base = (process.env.APP_URL || (host ? `${h.get('x-forwarded-proto') ?? 'https'}://${host}` : '')).replace(/\/+$/, '');
  after(() => flushQueuedAlerts(base));
}

export async function updateTaskAction(id: string, patch: TaskPatch, note?: string): Promise<Result<Task>> {
  await flushAlerts();
  return run(() => tasks.updateTask(id, patch, 'me', { note }));
}

export async function logProgressAction(id: string, progress: number, note?: string, status?: Status): Promise<Result<Task>> {
  await flushAlerts();
  return run(() => tasks.logProgress(id, progress, note, 'me', status));
}

export async function completeTaskAction(id: string, note?: string): Promise<Result<Task>> {
  await flushAlerts();
  return run(() => tasks.completeTask(id, note, 'me'));
}

export async function addCommentAction(id: string, note: string): Promise<Result<Task>> {
  return run(() => tasks.addComment(id, note, 'me'));
}

export async function setArchivedAction(id: string, archived: boolean): Promise<Result<Task>> {
  return run(() => tasks.setArchived(id, archived, 'me'));
}

export async function checklistAction(id: string, ops: tasks.ChecklistOps): Promise<Result<Task>> {
  return run(() => tasks.updateChecklist(id, ops, 'me'));
}

// ── Trash (delete / restore) and comment edits ─────────────────────────────
// run() revalidates the whole layout, which covers the task page, /review, /today,
// /tasks and project pages.

export async function deleteTaskAction(ref: number | string, reason?: string): Promise<Result<{ ref: number; title: string }>> {
  await flushAlerts();
  return run(() => tasks.trashTask(ref, 'me', { reason }));
}

export async function restoreTaskAction(ref: number | string): Promise<Result<Task>> {
  return run(() => tasks.restoreTask(ref, 'me'));
}

export async function purgeTrashItemAction(ref: number): Promise<Result<number>> {
  return run(async () => {
    const n = await tasks.purgeTrash(ref);
    if (!n) throw new NotFoundError(`#${ref} is not in the trash`);
    return n;
  });
}

export async function editCommentAction(activityId: string, text: string): Promise<Result<Activity>> {
  return run(() => tasks.editComment(activityId, text, 'me'));
}

export async function deleteCommentAction(activityId: string): Promise<Result<{ taskRef: number }>> {
  return run(() => tasks.deleteComment(activityId, 'me'));
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function createProjectAction(input: ProjectInput): Promise<Result<{ project: Project; created: boolean }>> {
  return run(() => projects.createProject(input));
}

export async function updateProjectAction(id: string, patch: Partial<ProjectInput>): Promise<Result<Project>> {
  return run(() => projects.updateProject(id, patch));
}

// ── Weekly review + Fiverr ritual ───────────────────────────────────────────

export async function createReview(input: Omit<WeeklyReview, 'id'>): Promise<WeeklyReview> {
  const r = await withCaller(await requireCaller(), () => reviews.createReview(input));
  revalidatePath('/review');
  return r;
}

export async function updateReview(id: string, patch: Partial<WeeklyReview>): Promise<void> {
  await withCaller(await requireCaller(), () => reviews.updateReview(id, patch));
  revalidatePath('/review');
}

export async function logFiverrRitual(input: { bidsPlaced: number; notes?: string }): Promise<FiverrRitualLog> {
  const log = await withCaller(await requireCaller(), () => reviews.logFiverrRitual(input));
  revalidatePath('/', 'layout');
  return log;
}

// ── Session ─────────────────────────────────────────────────────────────────

export async function logoutAction(): Promise<void> {
  // Ends this session in the database and clears its cookies (nextCookies plugin).
  await (await getAuth()).api.signOut({ headers: await headers() }).catch(() => {});
  redirect('/login');
}
