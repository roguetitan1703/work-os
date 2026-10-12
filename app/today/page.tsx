import { readData } from '@/lib/storage';
import { SCHEDULE } from '@/lib/schedule';
import { TodayClient } from './today-client';
import { format } from 'date-fns';

function getWeekdayKey(date: Date): 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | null {
  const keys = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;
  return keys[date.getDay()] ?? null;
}

export default function TodayPage() {
  const now = new Date();
  const data = readData();
  const weekday = getWeekdayKey(now);

  const allActiveTasks = data.tasks.filter(
    t => t.status !== 'Done' && t.status !== 'Dropped'
  );

  const todayISO = now.toISOString().slice(0, 10);
  const todayRitualLog = data.ritualLogs.find(r => r.date === todayISO) ?? null;

  const dayName = format(now, 'EEEE, MMMM d');
  const isNaturallyWeekend = now.getDay() === 0 || now.getDay() === 6;

  return (
    <TodayClient
      dayName={dayName}
      isNaturallyWeekend={isNaturallyWeekend}
      weekday={weekday}
      schedule={SCHEDULE}
      allActiveTasks={allActiveTasks}
      todayRitualLog={todayRitualLog}
    />
  );
}
