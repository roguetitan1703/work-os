import Link from '@/components/intent-link';
import { redirect } from 'next/navigation';
import { getCaller } from '@/lib/caller';
import { Activity, BarChart3, Play, SlidersHorizontal } from 'lucide-react';
import { NavIcon } from '@/components/nav-icons';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { claudeOverview } from '@/lib/data/claude-overview';
import { claudeTasks } from '@/lib/data/dispatcher';
import { deviceMap } from '@/lib/data/launcher';
import { usageReport } from '@/lib/data/claude-usage';
import { roster } from '@/lib/data/roster';
import { mergeSessions } from '@/lib/session-item';
import { cn } from '@/lib/utils';
import { baseUrl } from '../settings/base-url';
import { AutoRefresh } from './auto-refresh';
import { SessionsTab } from './now-tab';
import { SetupTab } from './setup-tab';
import { UsageTab } from './usage-tab';
import { messagesForYou } from '@/lib/data/messages';
import { openNeedsToMe } from '@/lib/data/needs';
import { asksBySession, withAskerSessions } from '@/lib/data/need-sessions';

export const metadata = { title: 'Claude · Work OS' };

const TABS = [
  { id: 'sessions', label: 'Sessions', icon: Activity },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'setup', label: 'Set up', icon: SlidersHorizontal },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Props = { searchParams: Promise<{ tab?: string; s?: string; range?: string }> };

export default async function ClaudePage({ searchParams }: Props) {
  const sp = await searchParams;
  // Old links: Now and Workers were two lists of the same sessions; both land on the one Sessions list.
  const tab: TabId = sp.tab === 'setup' ? 'setup' : sp.tab === 'usage' ? 'usage' : 'sessions';
  const me = await getCaller();
  if (!me) redirect('/login');
  const sc = { userId: me.userId, orgId: me.orgId };
  const [overview, tasks, workers, messages, needs] =
    tab === 'sessions'
      ? await Promise.all([claudeOverview(me), claudeTasks(me), roster(sc, { results: true }), messagesForYou(sc), openNeedsToMe(sc).then(n => withAskerSessions(sc, n))])
      : [null, null, null, [], []];
  const usage = tab === 'usage' ? await usageReport(sc, { range: sp.range, tz: me.tz }) : null;
  const asks = asksBySession(needs, me.userId);
  // Start Claude has nothing to start on until a computer exists; until then the page offers Set up Claude instead.
  const hasComputers = overview ? overview.hasComputers : (await deviceMap(me)).size > 0;
  // eslint-disable-next-line react-hooks/purity -- a server render runs once per request
  const now = Date.now();
  const view = overview && workers ? mergeSessions(workers.workers, overview.sessions, { tz: me.tz, now }) : null;
  const url = tab === 'setup' ? `${await baseUrl()}/api/mcp` : '';
  const startBtn = !hasComputers ? (
    <Link
      href="/claude?tab=setup"
      replace
      scroll={false}
      data-set-up-claude
      className="h-11 md:h-9 px-5 md:px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 bg-foreground text-background"
    >
      Set up Claude
    </Link>
  ) : (
    <Link
      href={`/claude?tab=${tab}&start=1`}
      scroll={false}
      data-start-claude
      className="h-11 md:h-9 px-5 md:px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 bg-foreground text-background"
    >
      <Play className="w-4 h-4" /> Start Claude
      <kbd className="hidden md:inline ml-1 text-label font-mono border border-background/40 rounded px-1">S</kbd>
    </Link>
  );

  return (
    <div className="max-w-6xl space-y-4 md:space-y-5 min-w-0">
      <MobileHeader title="Claude" />
      <div className="hidden md:flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-foreground">Claude</h1>
        {startBtn}
      </div>
      <div className="md:hidden">{startBtn}</div>

      <nav aria-label="Claude sections" className="inline-flex max-w-full gap-1 rounded-2xl bg-muted/60 p-1">
        {TABS.map(t => (
          <Link
            key={t.id}
            href={t.id === 'sessions' ? '/claude' : `/claude?tab=${t.id}`}
            replace
            scroll={false}
            aria-current={t.id === tab ? 'page' : undefined}
            data-tab={t.id}
            className={cn(
              'inline-flex items-center justify-center h-11 md:h-9 px-3.5 sm:px-5 rounded-xl text-sm font-medium whitespace-nowrap',
              t.id === tab ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground active:bg-background/60 hover:text-foreground',
            )}
          >
            <NavIcon icon={t.icon} size={16} className="mr-2 hidden sm:block" />
            {t.label}
          </Link>
        ))}
      </nav>

      {/* Set up refreshes too: it waits for a computer to connect and shows it when it does. */}
      <AutoRefresh stamp={now} />
      {tab === 'sessions' && view && overview && tasks && workers && (
        <SessionsTab
          view={view}
          tz={me.tz}
          openId={sp.s}
          couldBeRunning={workers.couldBeRunning}
          machines={workers.machines}
          hasComputers={overview.hasComputers}
          claudeTasks={tasks}
          reopen={overview.reopen}
          messages={messages}
          asks={asks}
        />
      )}
      {tab === 'usage' && usage && <UsageTab report={usage} />}
      {tab === 'setup' && <SetupTab url={url} />}
    </div>
  );
}
