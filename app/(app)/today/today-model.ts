'use client';

import { useEffect, useState } from 'react';
import type { Task } from '@/lib/types';
import { SCHEDULE, getCurrentBlock, type ScheduleBlock } from '@/lib/schedule';
import { RITUAL_MODE_MAP } from '@/lib/ritual-mode-map';
import { getBlockColor } from '@/lib/modes';
import { addDays } from '@/lib/dates';
import { useApp } from '@/components/app-context';

export const FLEX_KEY = 'workos-flex-override'; // shared by phone and desktop
export type Wd = 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
const WD_KEYS = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;
const RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const byPrio = (a: Task, b: Task) => RANK[a.priority] - RANK[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9') || a.ref - b.ref;

export type NextBlock = { block: ScheduleBlock; mode: string; hex: string };

/** Everything Today shows, worked out once: day mode, the current block, and the task sections (each task in exactly one place). */
export function useTodayModel({ tasks, waiting, isNaturallyWeekend, weekday }: { tasks: Task[]; waiting: Record<string, string[]>; isNaturallyWeekend: boolean; weekday: Wd | null }) {
  const { today } = useApp();
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

  const isFlexDay = isNaturallyWeekend ? !flexOverride : flexOverride;
  const effectiveWeekday: Wd = weekday ?? 'mon';
  const liveWeekday = now ? (WD_KEYS[now.getDay()] ?? (isNaturallyWeekend && !isFlexDay ? 'mon' : null)) : null;
  const liveBlock = now && !isFlexDay ? getCurrentBlock(now, true) : null;
  const rawBlockMode = liveBlock && liveWeekday ? liveBlock.modes[liveWeekday] : null;
  const nowMode: string | null = rawBlockMode ? (rawBlockMode in RITUAL_MODE_MAP ? RITUAL_MODE_MAP[rawBlockMode] || null : rawBlockMode) : null;
  const hex = rawBlockMode ? getBlockColor(rawBlockMode).hex : null;

  const seen = new Set<string>();
  const take = (list: Task[]) => list.filter(t => !seen.has(t.id) && (seen.add(t.id), true));
  const overdue = take(tasks.filter(t => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || byPrio(a, b)));
  const dueToday = take(tasks.filter(t => t.due === today).sort(byPrio));
  const inProgress = take(tasks.filter(t => t.status === 'In Progress').sort(byPrio));
  const blocked = take(tasks.filter(t => t.status === 'Blocked' || waiting[t.id]).sort(byPrio));
  // The NOW block only lists what the sections above don't already show; later groups skip its tasks too.
  const nowTasks = take(nowMode ? tasks.filter(t => t.mode === nowMode).sort(byPrio) : []);
  const week = addDays(today, 7);
  const upNext = take(tasks.filter(t => t.priority === 'P1' || (t.due && t.due <= week)).sort(byPrio));
  const alsoOpen = take([...tasks].sort(byPrio));

  // The next 3 blocks after the current one (or the first 3 of the day).
  const idx = liveBlock ? SCHEDULE.findIndex(b => b.block === liveBlock.block) : -1;
  const nextBlocks: NextBlock[] = SCHEDULE.slice(idx + 1, idx + 4).map(b => ({ block: b, mode: b.modes[effectiveWeekday], hex: getBlockColor(b.modes[effectiveWeekday]).hex }));

  return { today, isFlexDay, toggleFlex, effectiveWeekday, liveBlock, rawBlockMode, nowMode, hex, nowTasks, overdue, dueToday, inProgress, blocked, upNext, alsoOpen, nextBlocks };
}
