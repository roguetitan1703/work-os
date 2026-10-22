import { Sidebar } from '@/components/sidebar';
import { CurrentBlockBar } from '@/components/current-block-bar';
import { PageTint } from '@/components/page-tint';
import { TabBar } from '@/components/mobile/tab-bar';
import { PullToRefresh } from '@/components/mobile/pull-to-refresh';
import { Preloader } from '@/components/preloader';
import { StartClaude } from '@/components/start-claude';
import { unreadCount } from '@/lib/notify';
import { AppContextProvider } from '@/components/app-context';
import { listProjectsNav } from '@/lib/data/projects';
import { overdueCount } from '@/lib/data/summary';
import { claudeWaitingCount, systemStatusLevel } from '@/lib/data/nav-counts';
import { todayStr } from '@/lib/dates';
import { redirect } from 'next/navigation';
import { getCaller } from '@/lib/caller';
import { memberNames } from '@/lib/people';
import { getOrgModes } from '@/lib/org-modes';
import { getSchedule } from '@/lib/user-schedule';
import { NavTracker } from '@/components/nav-tracker';
import { GlobalShortcuts } from '@/components/shortcuts';
import { GlobalSearch } from '@/components/global-search';

// Every page reads live data (the MCP connector writes too), so never prerender.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // proxy.ts checked the session cookie; this also needs a membership (an account in no organization sees nothing).
  const caller = await getCaller();
  if (!caller) redirect('/login');
  const s = { userId: caller.userId, orgId: caller.orgId };
  const [projects, overdue, unread, claudeWaiting, status, people, modes, schedule] = await Promise.all([
    listProjectsNav(s),
    overdueCount(s),
    unreadCount(s),
    claudeWaitingCount(s).catch(() => 0),
    systemStatusLevel(s).catch(() => 'ok' as const),
    memberNames(s.orgId),
    getOrgModes(s.orgId),
    getSchedule(s),
  ]);
  return (
    <AppContextProvider
      today={todayStr(caller.tz)}
      unread={unread}
      me={s.userId}
      orgId={s.orgId}
      people={people}
      tz={caller.tz}
      modes={modes}
      plan={schedule.blocks.length ? { blocks: schedule.blocks, colors: schedule.colors, taskModes: schedule.taskModes } : null}
      badges={{ overdue, claudeWaiting, status }}
      projects={projects.map(p => ({ id: p.id, name: p.name, status: p.status }))}
    >
      <PageTint />
      <NavTracker />
      <GlobalShortcuts />
      <GlobalSearch />
      <Sidebar showSignOut />
      <main id="app-main" className="flex-1 min-w-0 overflow-y-auto overscroll-contain relative z-10 pb-[calc(env(safe-area-inset-bottom)+6rem)] md:pb-12">
        <div className="px-4 pt-3 md:p-6">{children}</div>
      </main>
      <CurrentBlockBar />
      <TabBar />
      <PullToRefresh targetId="app-main" />
      <StartClaude />
      <Preloader />
    </AppContextProvider>
  );
}
