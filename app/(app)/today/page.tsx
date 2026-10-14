import { format } from 'date-fns';
import { SCHEDULE } from '@/lib/schedule';
import { listTasks, unmetDependencies } from '@/lib/data/tasks';
import { getStats } from '@/lib/data/summary';
import { getRitualLog } from '@/lib/data/reviews';
import { todayStr, weekday } from '@/lib/dates';
import { TodayClient } from './today-client';
import { MobileToday } from '@/components/mobile/m-today';
import { noteIndex } from '@/lib/data/notes';

export default async function TodayPage() {
  const today = todayStr();
  const wd = weekday(today);
  const [open, stats, ritual] = await Promise.all([listTasks({ open: true }), getStats(), getRitualLog(today)]);
  const [waiting, notes] = await Promise.all([unmetDependencies(open), noteIndex({ taskIds: open.map(t => t.id) })]);
  const waitingRefs = Object.fromEntries([...waiting].map(([id, deps]) => [id, deps.map(d => `#${d.ref}`)]));
  const dayName = format(new Date(today + 'T12:00:00Z'), 'EEEE, MMMM d');
  const keys = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;

  return (
    <>
      <div className="md:hidden">
        <MobileToday
          dayName={dayName}
          tasks={open}
          waiting={waitingRefs}
          noteTaskIds={[...notes.byTask.keys()]}
          isNaturallyWeekend={wd === 0 || wd === 6}
          weekday={keys[wd]}
          schedule={SCHEDULE}
          todayRitualLog={ritual}
        />
      </div>
      <div className="hidden md:block">
    <TodayClient
      dayName={dayName}
      isNaturallyWeekend={wd === 0 || wd === 6}
      weekday={keys[wd]}
      schedule={SCHEDULE}
      openTasks={open}
      waiting={waitingRefs}
      stats={stats}
      todayRitualLog={ritual}
    />
      </div>
    </>
  );
}
