import Link from 'next/link';
import { Play } from 'lucide-react';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { claudeOverview } from '@/lib/data/claude-overview';
import { cn } from '@/lib/utils';
import { baseUrl } from '../connect/base-url';
import { AutoRefresh } from './auto-refresh';
import { NowTab } from './now-tab';
import { QueueTab } from './queue-tab';
import { SetupTab } from './setup-tab';

export const metadata = { title: 'Claude · Work OS' };

const TABS = [
  { id: 'now', label: 'Now' },
  { id: 'queue', label: 'Queue' },
  { id: 'setup', label: 'Setup' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Props = { searchParams: Promise<{ tab?: string }> };

export default async function ClaudePage({ searchParams }: Props) {
  const raw = (await searchParams).tab;
  const tab: TabId = TABS.find(t => t.id === raw)?.id ?? 'now';
  const data = tab === 'setup' ? null : await claudeOverview();
  const url = tab === 'setup' ? `${await baseUrl()}/api/mcp` : '';
  const startBtn = (
    <Link
      href={`/claude?tab=${tab}&start=1`}
      scroll={false}
      data-start-claude
      className="h-11 md:h-9 px-5 md:px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 bg-foreground text-background"
    >
      <Play className="w-4 h-4" /> Start Claude
      <kbd className="hidden md:inline ml-1 text-[10px] font-mono border border-background/40 rounded px-1">S</kbd>
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
            href={`/claude?tab=${t.id}`}
            replace
            scroll={false}
            aria-current={t.id === tab ? 'page' : undefined}
            data-tab={t.id}
            className={cn(
              'inline-flex items-center justify-center h-11 md:h-9 px-5 rounded-xl text-sm font-medium whitespace-nowrap',
              t.id === tab ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground active:bg-background/60 hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab !== 'setup' && <AutoRefresh />}
      {tab === 'now' && data && <NowTab needsYou={data.needsYou} sessions={data.sessions} summary={data.summary} hasComputers={data.hasComputers} />}
      {tab === 'queue' && data && <QueueTab groups={data.queue} />}
      {tab === 'setup' && <SetupTab url={url} />}
    </div>
  );
}
