import { Sidebar } from '@/components/sidebar';
import { CurrentBlockBar } from '@/components/current-block-bar';
import { PageTint } from '@/components/page-tint';
import { TabBar } from '@/components/mobile/tab-bar';
import { PullToRefresh } from '@/components/mobile/pull-to-refresh';
import { unreadCount } from '@/lib/notify';
import { AppContextProvider } from '@/components/app-context';
import { listProjectsBasic } from '@/lib/data/projects';
import { getStats } from '@/lib/data/summary';
import { collections } from '@/lib/db';
import { OPEN_STATUSES } from '@/lib/types';
import { todayStr } from '@/lib/dates';
import { untouchedCutoff } from '@/lib/untouched';

// Every page reads live data (the MCP connector writes too), so never prerender.
export const dynamic = 'force-dynamic';

async function hiddenCount(): Promise<number> {
  const c = await collections();
  return c.tasks.countDocuments({
    archived: false,
    status: { $in: OPEN_STATUSES },
    updatedAt: { $lt: untouchedCutoff() },
  });
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [projects, stats, hidden, unread] = await Promise.all([listProjectsBasic(), getStats(), hiddenCount(), unreadCount()]);
  return (
    <AppContextProvider today={todayStr()} unread={unread} projects={projects.map(p => ({ id: p.id, name: p.name, status: p.status }))}>
      <PageTint />
      <Sidebar stats={stats} hiddenCount={hidden} unread={unread} />
      <main id="app-main" className="flex-1 min-w-0 overflow-y-auto overscroll-contain relative z-10 pb-[calc(env(safe-area-inset-bottom)+6rem)] md:pb-12">
        <div className="px-4 pt-3 md:p-6">{children}</div>
      </main>
      <CurrentBlockBar />
      <TabBar />
      <PullToRefresh targetId="app-main" />
    </AppContextProvider>
  );
}
