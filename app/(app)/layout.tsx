import { Sidebar } from '@/components/sidebar';
import { CurrentBlockBar } from '@/components/current-block-bar';
import { PageTint } from '@/components/page-tint';
import { TabBar } from '@/components/mobile/tab-bar';
import { PullToRefresh } from '@/components/mobile/pull-to-refresh';
import { Preloader } from '@/components/preloader';
import { StartClaude } from '@/components/start-claude';
import { unreadCount } from '@/lib/notify';
import { AppContextProvider } from '@/components/app-context';
import { listProjectsBasic } from '@/lib/data/projects';
import { getStats } from '@/lib/data/summary';
import { claudeWaitingCount, systemStatusLevel } from '@/lib/data/nav-counts';
import { todayStr } from '@/lib/dates';
import { uiAuthDisabled } from '@/lib/auth';
import { NavTracker } from '@/components/nav-tracker';
import { GlobalShortcuts } from '@/components/shortcuts';

// Every page reads live data (the MCP connector writes too), so never prerender.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [projects, stats, unread, claudeWaiting, status] = await Promise.all([
    listProjectsBasic(),
    getStats(),
    unreadCount(),
    claudeWaitingCount().catch(() => 0),
    systemStatusLevel().catch(() => 'ok' as const),
  ]);
  return (
    <AppContextProvider
      today={todayStr()}
      unread={unread}
      badges={{ overdue: stats.overdue, claudeWaiting, status }}
      projects={projects.map(p => ({ id: p.id, name: p.name, status: p.status }))}
    >
      <PageTint />
      <NavTracker />
      <GlobalShortcuts />
      <Sidebar showSignOut={!uiAuthDisabled()} />
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
