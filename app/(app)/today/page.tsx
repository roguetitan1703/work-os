import { format } from 'date-fns';
import { redirect } from 'next/navigation';
import { getCaller } from '@/lib/caller';
import { getChecklist } from '@/lib/get-started';
import { weekdayKey } from '@/lib/schedule';
import { getSchedule } from '@/lib/user-schedule';
import { listTasks, unmetDependencies } from '@/lib/data/tasks';
import { todayStr, weekday } from '@/lib/dates';
import { TodayClient } from './today-client';
import { taskIdsWithNotes } from '@/lib/data/notes';
import { claudeOverview } from '@/lib/data/claude-overview';
import type { ClaudeCardData } from './claude-card';

export const metadata = { title: 'Today · Work OS' };

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const sp = await searchParams;
  const me = await getCaller();
  if (!me) redirect('/login');
  const today = todayStr(me.tz);
  const wd = weekday(today);
  const s = { userId: me.userId, orgId: me.orgId };
  const [open, schedule, overview, checklist] = await Promise.all([listTasks(s, { open: true, forList: true }), getSchedule(s), claudeOverview(me, { card: true }).catch(() => null), getChecklist(me).catch(() => null)]);
  const [waiting, notes] = await Promise.all([unmetDependencies(s, open), taskIdsWithNotes(s, open.map(t => t.id))]);
  const waitingRefs = Object.fromEntries([...waiting].map(([id, deps]) => [id, deps.map(d => `#${d.ref}`)]));
  const dayName = format(new Date(today + 'T12:00:00Z'), 'EEEE, MMMM d');
  const claude: ClaudeCardData | null = overview ? { needsYou: overview.needsYou, hasComputers: overview.hasComputers, running: overview.sessions.filter(r => r.state === 'working' || r.state === 'open' || r.state === 'idle' || r.state === 'starting').length, activity: overview.activity } : null;

  return (
    <TodayClient
      dayName={dayName}
      isNaturallyWeekend={wd === 0 || wd === 6}
      weekday={weekdayKey(wd)}
      openTasks={open}
      waiting={waitingRefs}
      noteTaskIds={[...notes]}
      claude={claude}
      checklist={checklist}
      welcome={sp.welcome ? `Welcome, ${(me.name || me.email).split(/[ @]/)[0]}.` : null}
    />
  );
}
