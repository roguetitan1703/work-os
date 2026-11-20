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
import { openNeedsToMe } from '@/lib/data/needs';
import { whatsNewState } from '@/lib/whats-new-seen';
import type { WhatsNewCardData } from './whats-new-card';
import { projectsNow } from '@/lib/data/today-projects';

const WHATS_NEW_MAX = 3;

export const metadata = { title: 'Today · Work OS' };

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const sp = await searchParams;
  const me = await getCaller();
  if (!me) redirect('/login');
  const today = todayStr(me.tz);
  const wd = weekday(today);
  const s = { userId: me.userId, orgId: me.orgId };
  const openP = listTasks(s, { open: true, forList: true });
  const [open, schedule, overview, checklist] = await Promise.all([openP, getSchedule(s), claudeOverview(me, { card: true }).catch(() => null), openP.then(o => getChecklist(me, { skipIfHidden: true, hasOpenTask: o.length > 0 })).catch(() => null)]);
  const [waiting, notes, needs, news] = await Promise.all([unmetDependencies(s, open), taskIdsWithNotes(s, open.map(t => t.id)), openNeedsToMe(s).catch(() => []), whatsNewState(me).catch(() => null)]);
  const projectRows = await projectsNow(s, {
    needProjects: needs.map(n => n.projectId),
    taskProjects: open.filter(t => t.projectId && t.assigneeIds.includes(me.userId)).map(t => t.projectId as string),
  }).catch(() => []);
  const whatsNew: WhatsNewCardData | null = news?.unseen.length ? { entries: news.unseen.slice(0, WHATS_NEW_MAX), more: Math.max(0, news.unseen.length - WHATS_NEW_MAX) } : null;
  const waitingRefs = Object.fromEntries([...waiting].map(([id, deps]) => [id, deps.map(d => `#${d.ref}`)]));
  const dayName = format(new Date(today + 'T12:00:00Z'), 'EEEE, MMMM d');
  const claude: ClaudeCardData | null = overview ? { hasComputers: overview.hasComputers, running: overview.sessions.filter(r => r.state === 'working' || r.state === 'open' || r.state === 'idle' || r.state === 'starting').length, activity: overview.activity } : null;

  return (
    <TodayClient
      dayName={dayName}
      isNaturallyWeekend={wd === 0 || wd === 6}
      weekday={weekdayKey(wd)}
      openTasks={open}
      waiting={waitingRefs}
      noteTaskIds={[...notes]}
      claude={claude}
      needs={needs}
      projectRows={projectRows}
      checklist={checklist}
      whatsNew={whatsNew}
      welcome={sp.welcome ? `Welcome, ${(me.name || me.email).split(/[ @]/)[0]}.` : null}
    />
  );
}
