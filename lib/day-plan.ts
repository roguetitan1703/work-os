import { Task } from './types';
import { blockMinutes, taskModeFor, type ScheduleBlock, type WeekPlan, type Wd } from './schedule';

export type SlotAssignment = {
  block: ScheduleBlock;
  weekday: Wd;
  modeName: string;         // raw block mode (e.g. "Setup/Close")
  taskMode: string | null;  // resolved task mode (e.g. "Business Admin")
  slotMins: number;
  tasks: ScheduledTask[];
  usedMins: number;
  freeMins: number;
  overflowMins: number;
};

export type ScheduledTask = {
  task: Task;
  startOffset: number; // minutes from slot start
  endsOffset: number;
};

export type UnscheduledTask = {
  task: Task;
  reason: string;
};

export type DayPlan = {
  slots: SlotAssignment[];
  unscheduled: UnscheduledTask[];
  totalTaskMins: number;
  totalSlotMins: number;
};


const PRIORITY_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

/** The person's day: their schedule's blocks for this weekday, filled with open tasks of each block's mode. */
export function buildDayPlan(allTasks: Task[], weekday: Wd, plan: WeekPlan | null): DayPlan {
  // Only active tasks
  const active = allTasks.filter(t => t.status !== 'Done' && t.status !== 'Dropped');

  // Sort tasks: priority first, then due date, then estimate
  const sorted = [...active].sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return (a.estimateMins ?? 30) - (b.estimateMins ?? 30);
  });

  // Group tasks by mode
  const tasksByMode = new Map<string, Task[]>();
  for (const t of sorted) {
    if (!t.mode) continue;
    if (!tasksByMode.has(t.mode)) tasksByMode.set(t.mode, []);
    tasksByMode.get(t.mode)!.push(t);
  }

  // Track which tasks have been placed
  const placed = new Set<string>();

  const slots: SlotAssignment[] = [];

  for (const blk of plan?.blocks ?? []) {
    const rawMode = blk.modes[weekday];
    const taskMode = plan ? taskModeFor(plan, rawMode) : null;

    const slotMins = blockMinutes(blk);
    const slotTasks: ScheduledTask[] = [];
    let cursor = 0;

    if (taskMode) {
      const candidates = tasksByMode.get(taskMode) ?? [];
      for (const task of candidates) {
        if (placed.has(task.id)) continue;
        // EDF: place task if it fits, or place it anyway (overflow) if P1
        const est = task.estimateMins || 30;
        slotTasks.push({ task, startOffset: cursor, endsOffset: cursor + est });
        cursor += est;
        placed.add(task.id);
        // Stop once we've filled 3x the slot (show overflow but don't go infinite)
        if (cursor > slotMins * 3) break;
      }
    }

    const usedMins = cursor;
    const freeMins = Math.max(0, slotMins - usedMins);
    const overflowMins = Math.max(0, usedMins - slotMins);

    slots.push({ block: blk, weekday, modeName: rawMode, taskMode, slotMins, tasks: slotTasks, usedMins, freeMins, overflowMins });
  }

  // Unscheduled = tasks never placed (mode has no slot today, or no tasks fit)
  const unscheduled: UnscheduledTask[] = active
    .filter(t => !placed.has(t.id))
    .map(t => ({
      task: t,
      reason: t.mode ? `No time slot scheduled for ${t.mode} today` : 'No mode set',
    }));

  const totalTaskMins = active.reduce((s, t) => s + (t.estimateMins ?? 0), 0);
  const totalSlotMins = slots.reduce((s, sl) => s + sl.slotMins, 0);

  return { slots, unscheduled, totalTaskMins, totalSlotMins };
}
