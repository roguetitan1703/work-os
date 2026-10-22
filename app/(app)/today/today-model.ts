'use client';

import { useEffect, useState } from 'react';
import type { Task } from '@/lib/types';
import { currentBlock, taskModeFor, type ScheduleBlock, type Wd } from '@/lib/schedule';
import { addDays } from '@/lib/dates';
import { useApp, useModes } from '@/components/app-context';

export type { Wd };
export const FLEX_KEY = 'workos-flex-override'; // shared by phone and desktop
const RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const byPrio = (a: Task, b: Task) => RANK[a.priority] - RANK[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9') || a.ref - b.ref;

export type NextBlock = { block: ScheduleBlock; mode: string; hex: string };

/**
 * Everything Today shows, worked out once: day mode, the current block (from the person's own schedule, in their
 * timezone; none without one), and the task sections (each task in exactly one place).
 */
export function useTodayModel({ tasks, waiting, isNaturallyWeekend, weekday }: { tasks: Task[]; waiting: Record<string, string[]>; isNaturallyWeekend: boolean; weekday: Wd | null }) {
  const { today, plan, tz, me } = useApp();
  const { color } = useModes();
  const [flexOverride, setFlexOverride] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read localStorage after hydration
      setFlexOverride(localStorage.getItem(FLEX_KEY) === 'true');
    } catch {}
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  function toggleFlex() {
    const next = !flexOverride;
    setFlexOverride(next);
    try {
      localStorage.setItem(FLEX_KEY, String(next));
    } catch {}
  }

  const blocks = plan?.blocks ?? [];
  const isFlexDay = isNaturallyWeekend ? !flexOverride : flexOverride;
  const effectiveWeekday: Wd = weekday ?? 'mon';
  const live = now && !isFlexDay && plan ? currentBlock(blocks, now, tz, true) : null;
  const liveBlock = live?.block ?? null;
  const rawBlockMode = live ? live.block.modes[live.weekday] || null : null;
  const nowMode: string | null = plan ? taskModeFor(plan, rawBlockMode) : null;
  const hex = rawBlockMode ? color(rawBlockMode).hex : null;

  const seen = new Set<string>();
  const take = (list: Task[]) => list.filter(t => !seen.has(t.id) && (seen.add(t.id), true));
  const overdue = take(tasks.filter(t => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || byPrio(a, b)));
  const dueToday = take(tasks.filter(t => t.due === today).sort(byPrio));
  const inProgress = take(tasks.filter(t => t.status === 'In Progress').sort(byPrio));
  const blocked = take(tasks.filter(t => t.status === 'Blocked' || waiting[t.id]).sort(byPrio));
  // Assigned to you (phase 4), what the sections above don't already show; Tasks › Assigned to me has them all.
  const assignedTotal = tasks.filter(t => !!me && t.assigneeId === me).length;
  const assigned = take(tasks.filter(t => !!me && t.assigneeId === me).sort(byPrio));
  // The NOW block only lists what the sections above don't already show; later groups skip its tasks too.
  const nowTasks = take(nowMode ? tasks.filter(t => t.mode === nowMode).sort(byPrio) : []);
  const week = addDays(today, 7);
  const upNext = take(tasks.filter(t => t.priority === 'P1' || (t.due && t.due <= week)).sort(byPrio));
  const alsoOpen = take([...tasks].sort(byPrio));

  // The next 3 blocks after the current one (or the first 3 of the day).
  const idx = liveBlock ? blocks.indexOf(liveBlock) : -1;
  const nextBlocks: NextBlock[] = blocks.slice(idx + 1, idx + 4).map(b => ({ block: b, mode: b.modes[effectiveWeekday], hex: color(b.modes[effectiveWeekday]).hex }));

  return { today, hasSchedule: !!plan, isFlexDay, toggleFlex, effectiveWeekday, liveBlock, rawBlockMode, nowMode, hex, nowTasks, overdue, dueToday, inProgress, blocked, assigned, assignedTotal, upNext, alsoOpen, nextBlocks };
}
