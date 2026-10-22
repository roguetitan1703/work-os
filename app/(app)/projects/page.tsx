import Link from '@/components/intent-link';
import { FolderOpen } from 'lucide-react';
import { listProjects } from '@/lib/data/projects';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MEmpty } from '@/components/mobile/sub-header';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { HubSegment } from '@/components/mobile/hub-segment';
import { waitingCounts } from '@/lib/data/claude-items';
import { NewProjectButton } from './new-project';
import { requireScope } from '@/lib/caller';

type Props = { searchParams: Promise<{ all?: string }> };

export const metadata = { title: 'Projects · Work OS' };

export default async function ProjectsPage({ searchParams }: Props) {
  const { all } = await searchParams;
  const s = await requireScope();
  const [projects, waiting] = await Promise.all([listProjects(s, { includeInactive: all === '1' }), waitingCounts(s)]);

  return (
    <div className="space-y-5 max-w-6xl">
      <MobileHeader title="Projects" subtitle={`${projects.length} ${all === '1' ? 'total' : 'active or paused'}`} right={<NewProjectButton />} />
      <HubSegment active="projects" />
      <div className="md:hidden flex gap-2">
        {[
          { href: '/projects', label: 'Active', on: all !== '1' },
          { href: '/projects?all=1', label: 'All', on: all === '1' },
        ].map(c => (
          <Link
            key={c.label}
            href={c.href}
            replace
            className={cn('h-11 px-5 inline-flex items-center rounded-full border text-sm font-medium active:scale-95 transition-transform', c.on ? 'bg-foreground text-background border-foreground' : 'border-border bg-card')}
          >
            {c.label}
          </Link>
        ))}
      </div>

      <div className="hidden md:flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {projects.length} {all === '1' ? 'total' : 'active or paused'} ·{' '}
            <Link href={all === '1' ? '/projects' : '/projects?all=1'} className="underline">
              {all === '1' ? 'hide finished' : 'show all'}
            </Link>
          </p>
        </div>
        <NewProjectButton />
      </div>

      {projects.length === 0 && (
        <MEmpty icon={<FolderOpen className="w-5 h-5" />} title="No projects yet" hint="Tap + to create your first one." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {projects.map(p => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className={cn(
              'rounded-2xl md:rounded-xl border border-border/70 md:border-border bg-card p-4 space-y-3 hover:bg-muted/40 active:bg-muted/60 transition-colors',
              p.status !== 'active' && 'opacity-70',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-[16px] md:text-base text-foreground truncate">{p.name}</span>
                  {waiting.get(p.id) && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0">{waiting.get(p.id)} for you</span>}
                </div>
                {p.client && <div className="text-sm md:text-xs text-muted-foreground truncate">{p.client}</div>}
              </div>
              {p.status !== 'active' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p.status}</span>}
            </div>
            <div className="space-y-1">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-green-500" style={{ width: `${p.stats.completion}%` }} />
              </div>
              <div className="flex justify-between text-xs md:text-[11px] text-muted-foreground">
                <span>
                  {p.stats.done} done · {p.stats.open} open
                </span>
                <span>{p.stats.completion}%</span>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs flex-wrap">
              {p.stats.overdue > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{p.stats.overdue} overdue</span>}
              {p.stats.inProgress > 0 && <span className="text-blue-600 dark:text-blue-400">{p.stats.inProgress} in progress</span>}
              {p.stats.blocked > 0 && <span className="text-red-600 dark:text-red-400">{p.stats.blocked} blocked</span>}
              {p.stats.doneThisWeek > 0 && <span className="text-green-600 dark:text-green-400">{p.stats.doneThisWeek} done this week</span>}
              {p.stats.lastActivityAt && <span className="text-muted-foreground ml-auto">{fmtAgo(p.stats.lastActivityAt)}</span>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
