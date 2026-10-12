'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { readData, writeData } from '@/lib/storage';
import { Task, TaskSchema, WeeklyReview, WeeklyReviewSchema, FiverrRitualLog, FiverrRitualLogSchema } from '@/lib/types';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function createTask(input: Omit<Task, 'id' | 'addedOn' | 'lastTouched'>): Promise<Task> {
  const data = readData();
  const now = todayISO();
  const task: Task = TaskSchema.parse({
    ...input,
    id: randomUUID(),
    addedOn: now,
    lastTouched: now,
  });
  data.tasks.push(task);
  writeData(data);
  revalidatePath('/', 'layout');
  return task;
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
  const data = readData();
  const idx = data.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const now = todayISO();
  const updated: Task = TaskSchema.parse({
    ...data.tasks[idx],
    ...patch,
    lastTouched: now,
    doneDate: patch.status === 'Done' && !data.tasks[idx].doneDate ? now : data.tasks[idx].doneDate,
  });
  data.tasks[idx] = updated;
  writeData(data);
  revalidatePath('/', 'layout');
  return updated;
}

export async function deleteTask(id: string): Promise<void> {
  const data = readData();
  data.tasks = data.tasks.filter(t => t.id !== id);
  writeData(data);
  revalidatePath('/', 'layout');
}

export async function bulkInsertTasks(tasks: Omit<Task, 'id' | 'addedOn' | 'lastTouched'>[]): Promise<Task[]> {
  const data = readData();
  const now = todayISO();
  const inserted: Task[] = tasks.map(t => TaskSchema.parse({
    ...t,
    id: randomUUID(),
    addedOn: now,
    lastTouched: now,
  }));
  data.tasks.push(...inserted);
  writeData(data);
  revalidatePath('/', 'layout');
  return inserted;
}

export async function createReview(input: Omit<WeeklyReview, 'id'>): Promise<WeeklyReview> {
  const data = readData();
  const review = WeeklyReviewSchema.parse({ ...input, id: randomUUID() });
  data.reviews.push(review);
  writeData(data);
  revalidatePath('/review');
  return review;
}

export async function updateReview(id: string, patch: Partial<WeeklyReview>): Promise<void> {
  const data = readData();
  const idx = data.reviews.findIndex(r => r.id === id);
  if (idx === -1) return;
  data.reviews[idx] = WeeklyReviewSchema.parse({ ...data.reviews[idx], ...patch });
  writeData(data);
  revalidatePath('/review');
}

export async function logFiverrRitual(
  input: { bidsPlaced: number; notes?: string },
): Promise<FiverrRitualLog> {
  const data = readData();
  const date = todayISO();
  const existing = data.ritualLogs.findIndex(r => r.date === date);
  const log = FiverrRitualLogSchema.parse({ ...input, id: randomUUID(), date });
  if (existing !== -1) {
    // overwrite today's log if re-submitted
    data.ritualLogs[existing] = log;
  } else {
    data.ritualLogs.push(log);
  }
  writeData(data);
  revalidatePath('/', 'layout');
  return log;
}
