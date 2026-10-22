import { format } from 'date-fns';
import { SCHEDULE } from '@/lib/schedule';
import { listTasks, unmetDependencies } from '@/lib/data/tasks';
import { getRitualLog } from '@/lib/data/reviews';
import { todayStr, weekday } from '@/lib/dates';
import { TodayClient } from './today-client';
import { taskIdsWithNotes } from '@/lib/data/notes';
import { claudeOverview } from '@/lib/data/claude-overview';
import type { ClaudeCardData } from './claude-card';

export const metadata = { title: 'Today · Work OS' };

export default async function TodayPage() {
  const today = todayStr();
  const wd = weekday(today);
  const [open, ritual, overview] = await Promise.all([listTasks({ open: true }), getRitualLog(today), claudeOverview().catch(() => null)]);
  const [waiting, notes] = await Promise.all([unmetDependencies(open), taskIdsWithNotes(open.map(t => t.id))]);
  const waitingRefs = Object.fromEntries([...waiting].map(([id, deps]) => [id, deps.map(d => `#${d.ref}`)]));
  const dayName = format(new Date(today + 'T12:00:00Z'), 'EEEE, MMMM d');
  const keys = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;
  const claude: ClaudeCardData | null = overview ? { needsYou: overview.needsYou, running: overview.sessions.filter(r => r.state === 'working' || r.state === 'open' || r.state === 'idle' || r.state === 'starting').length, activity: overview.activity } : null;

  return (
    <TodayClient
      dayName={dayName}
      isNaturallyWeekend={wd === 0 || wd === 6}
      weekday={keys[wd]}
      schedule={SCHEDULE}
      openTasks={open}
      waiting={waitingRefs}
      noteTaskIds={[...notes]}
      claude={claude}
      todayRitualLog={ritual}
    />
  );
}
