import { listTasks, type DueFilter } from '@/lib/data/tasks';
import { listProjectsBasic } from '@/lib/data/projects';
import { todayStr, weekStart } from '@/lib/dates';
import { ModeSchema, type Mode } from '@/lib/types';
import { BoardClient } from './board-client';

type Props = { searchParams: Promise<{ project?: string; mode?: string; due?: string; q?: string }> };

const DUE: DueFilter[] = ['overdue', 'today', 'today_or_overdue', 'this_week', 'next_7_days', 'no_date'];

export default async function BoardPage({ searchParams }: Props) {
  const sp = await searchParams;
  const mode = ModeSchema.safeParse(sp.mode).success ? (sp.mode as Mode) : undefined;
  const due = DUE.includes(sp.due as DueFilter) ? (sp.due as DueFilter) : undefined;
  const common = { project: sp.project || undefined, mode, due, q: sp.q || undefined };
  const [open, doneThisWeek, projects] = await Promise.all([
    listTasks({ ...common, open: true }),
    listTasks({ ...common, due: undefined, status: ['Done'], doneFrom: weekStart(todayStr()), sort: 'done' }),
    listProjectsBasic(),
  ]);
  return (
    <BoardClient
      tasks={[...open, ...doneThisWeek]}
      projects={projects.filter(p => p.status === 'active' || p.status === 'paused').map(p => ({ id: p.id, name: p.name }))}
      filters={{ project: sp.project ?? '', mode: mode ?? '', due: due ?? '', q: sp.q ?? '' }}
    />
  );
}
