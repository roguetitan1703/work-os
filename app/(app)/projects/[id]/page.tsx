import { notFound } from 'next/navigation';
import { getProjectWithStats } from '@/lib/data/projects';
import { listActivity, listTasks } from '@/lib/data/tasks';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';
import { ProjectHeader } from './project-header';

type Props = { params: Promise<{ id: string }> };

export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  const project = await getProjectWithStats(decodeURIComponent(id));
  if (!project) notFound();

  const [open, done, activity] = await Promise.all([
    listTasks({ project: project.id, open: true }),
    listTasks({ project: project.id, status: ['Done', 'Dropped'], sort: 'done', limit: 30 }),
    listActivity({ project: project.id, limit: 40 }),
  ]);
  const s = project.stats;

  return (
    <div className="grid grid-cols-[minmax(0,_1.7fr)_minmax(0,_1fr)] gap-6 items-start max-w-6xl">
      <div className="space-y-5">
        <ProjectHeader project={project} />

        <div className="grid grid-cols-4 gap-2">
          <Stat label="Open" value={s.open} />
          <Stat label="Overdue" value={s.overdue} tone={s.overdue ? 'text-red-600 dark:text-red-400' : ''} />
          <Stat label="Done this week" value={s.doneThisWeek} tone="text-green-600 dark:text-green-400" />
          <Stat label="Complete" value={`${s.completion}%`} sub={`${s.done}/${s.done + s.open}`} />
        </div>

        <QuickAddBar defaults={{ project: project.name }} />

        <section className="space-y-1">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Open</h2>
          <TaskList tasks={open} showProject={false} empty="Nothing open." />
        </section>
        <section className="space-y-1">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recently finished</h2>
          <TaskList tasks={done} showProject={false} empty="Nothing finished yet." />
        </section>
      </div>
      <aside className="space-y-3">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Activity</h2>
        <ActivityTimeline items={activity} showTask />
      </aside>
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: number | string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
        {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}
