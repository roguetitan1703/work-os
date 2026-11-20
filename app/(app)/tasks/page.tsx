import { listTasks, type DueFilter } from '@/lib/data/tasks';
import { listProjectsBasic } from '@/lib/data/projects';
import { todayStr, weekStart } from '@/lib/dates';
import { ModeSchema, type Mode } from '@/lib/types';
import { BoardClient } from './board-client';
import { MobileTasks } from '@/components/mobile/m-tasks';
import { taskIdsWithNotes } from '@/lib/data/notes';
import { requireScope } from '@/lib/caller';
import { openNeedsToMe } from '@/lib/data/needs';
import { withAskerSessions } from '@/lib/data/need-sessions';
import { NeedsYou } from '@/components/needs';
import { placesOfTasks } from '@/lib/data/purpose';
import { PlacesProvider } from '@/components/task-place';

/** Tasks shows this many of the Needs waiting on you; See all opens the Needs page. */
const NEEDS_MAX = 3;

type Props = { searchParams: Promise<{ project?: string; mode?: string; due?: string; q?: string; search?: string; assigned?: string }> };

const DUE: DueFilter[] = ['overdue', 'today', 'today_or_overdue', 'this_week', 'next_7_days', 'no_date'];

export const metadata = { title: 'Tasks · Work OS' };

export default async function BoardPage({ searchParams }: Props) {
  const sp = await searchParams;
  const mode = ModeSchema.safeParse(sp.mode).success ? (sp.mode as Mode) : undefined;
  const due = DUE.includes(sp.due as DueFilter) ? (sp.due as DueFilter) : undefined;
  const s = await requireScope();
  // ?assigned=me: the "Assigned to me" view (docs/multi-user.md phase 4).
  const assigned = sp.assigned === 'me' ? 'me' : '';
  const common = { project: sp.project || undefined, mode, due, q: sp.q || undefined, assignee: assigned ? s.userId : undefined };
  const [open, doneThisWeek, projects, needs] = await Promise.all([
    listTasks(s, { ...common, open: true, forList: true }),
    listTasks(s, { ...common, due: undefined, status: ['Done'], doneFrom: weekStart(todayStr()), sort: 'done', forList: true }),
    listProjectsBasic(s),
    openNeedsToMe(s)
      .then(l => withAskerSessions(s, l))
      .catch(() => []),
  ]);
  const active = projects.filter(p => p.status === 'active' || p.status === 'paused').map(p => ({ id: p.id, name: p.name, private: p.visibility === 'private' }));
  const all = [...open, ...doneThisWeek];
  const [notes, places] = await Promise.all([taskIdsWithNotes(s, all.map(t => t.id)), placesOfTasks(s, all)]);
  return (
    <PlacesProvider places={places}>
      <div className="md:hidden">
        <MobileTasks top={needs.length ? <NeedsYou needs={needs} phone max={NEEDS_MAX} seeAll="/needs" /> : null} focusSearch={sp.search === '1'} tasks={all} projects={active} noteTaskIds={[...notes]} filters={{ project: sp.project ?? '', mode: mode ?? '', due: due ?? '', q: sp.q ?? '', assigned }} />
      </div>
      <div className="hidden md:block">
    <BoardClient focusSearch={sp.search === '1'}
      top={needs.length ? <NeedsYou needs={needs} phone={false} max={NEEDS_MAX} seeAll="/needs" /> : null}
      tasks={[...open, ...doneThisWeek]}
      projects={projects.filter(p => p.status === 'active' || p.status === 'paused').map(p => ({ id: p.id, name: p.name, private: p.visibility === 'private' }))}
      filters={{ project: sp.project ?? '', mode: mode ?? '', due: due ?? '', q: sp.q ?? '', assigned }}
    />
      </div>
    </PlacesProvider>
  );
}
