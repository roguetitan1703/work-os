import { format } from 'date-fns';
import { SCHEDULE } from '@/lib/schedule';
import { listTasks, unmetDependencies } from '@/lib/data/tasks';
import { getStats } from '@/lib/data/summary';
import { getRitualLog } from '@/lib/data/reviews';
import { todayStr, weekday } from '@/lib/dates';
import { TodayClient } from './today-client';

export default async function TodayPage() {
  const today = todayStr();
  const wd = weekday(today);
  const [open, stats, ritual] = await Promise.all([listTasks({ open: true }), getStats(), getRitualLog(today)]);
  const waiting = await unmetDependencies(open);
  const keys = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;

  return (
    <TodayClient
      dayName={format(new Date(today + 'T12:00:00Z'), 'EEEE, MMMM d')}
      isNaturallyWeekend={wd === 0 || wd === 6}
      weekday={keys[wd]}
      schedule={SCHEDULE}
      openTasks={open}
      waiting={Object.fromEntries([...waiting].map(([id, deps]) => [id, deps.map(d => `#${d.ref}`)]))}
      stats={stats}
      todayRitualLog={ritual}
    />
  );
}
