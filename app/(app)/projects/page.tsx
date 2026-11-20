import { PeopleBadge, PrivateBadge } from '@/components/private-badge';
import Link from '@/components/intent-link';
import { PLACE_ICON, NavIcon } from '@/components/nav-icons';
import { listProjects } from '@/lib/data/projects';
import { nowOfProjects } from '@/lib/data/states';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MEmpty } from '@/components/mobile/sub-header';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { HubSegment } from '@/components/mobile/hub-segment';
import { NewProjectButton } from './new-project';
import { requireScope } from '@/lib/caller';

type Props = { searchParams: Promise<{ all?: string }> };

export const metadata = { title: 'Projects · Work OS' };

export default async function ProjectsPage({ searchParams }: Props) {
  const { all } = await searchParams;
  const s = await requireScope();
  const projects = await listProjects(s, { includeInactive: all === '1' });
  const goals = await nowOfProjects(s, projects.map(p => p.id));

  return (
    <div className="space-y-5 max-w-6xl">
      <MobileHeader title="Projects" subtitle={`${projects.length} ${all === '1' ? 'total' : 'active or paused'}`} />
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
        <span className="ml-auto">
          <NewProjectButton />
        </span>
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
        <div data-projects-empty>
          <div className="md:hidden">
            <MEmpty icon={<NavIcon icon={PLACE_ICON.projects} size={20} />} title="No projects yet" hint="Tap New project to create your first one. A project groups tasks, notes and Claude for one client or product." />
          </div>
          <div className="hidden md:block">
            <MEmpty icon={<NavIcon icon={PLACE_ICON.projects} size={20} />} title="No projects yet" hint="Click New project. A project groups tasks, notes and Claude for one client or product." />
          </div>
        </div>
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
                  {p.visibility === 'private' && <PrivateBadge />}
                  {p.visibility === 'members' && <PeopleBadge count={p.sharedWith?.length ?? 1} />}
                </div>
                {p.client && <div className="text-sm md:text-xs text-muted-foreground truncate">{p.client}</div>}
              </div>
              {p.status !== 'active' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p.status}</span>}
            </div>
            {goals[p.id]?.now ? (
              <p className="text-[15px] md:text-sm text-foreground leading-snug line-clamp-2 break-words" data-project-now>
                {goals[p.id].now}
              </p>
            ) : p.description.trim() ? (
              <p className="text-[15px] md:text-sm text-muted-foreground leading-snug line-clamp-2 break-words" data-project-description>
                {p.description.trim()}
              </p>
            ) : null}
            <div className="flex items-center gap-3 text-xs flex-wrap">
              <span className="text-muted-foreground">{p.stats.done} done · {p.stats.open} open</span>
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
