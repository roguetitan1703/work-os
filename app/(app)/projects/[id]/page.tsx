import { notFound } from 'next/navigation';
import { getProjectWithStats } from '@/lib/data/projects';
import { listActivity, listTasks } from '@/lib/data/tasks';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';
import { ProjectHeader } from './project-header';
import Link from 'next/link';
import { ChevronRight, FileText } from 'lucide-react';
import { listNotes } from '@/lib/data/notes';
import { NewNoteButton } from '@/components/new-note-button';
import { fmtAgo } from '@/lib/format';
import { SubHeader } from '@/components/mobile/sub-header';
import { AddTaskButton } from './add-task-button';

type Props = { params: Promise<{ id: string }> };

const H2 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';

export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  const project = await getProjectWithStats(decodeURIComponent(id));
  if (!project) notFound();

  const [open, done, activity, notes] = await Promise.all([
    listTasks({ project: project.id, open: true }),
    listTasks({ project: project.id, status: ['Done', 'Dropped'], sort: 'done', limit: 30 }),
    listActivity({ project: project.id, limit: 40 }),
    listNotes({ project: project.id, state: 'all' }),
  ]);
  const projectNotes = notes.notes.filter(n => !n.taskId && !n.archived);
  const otherNotes = notes.notes.length - projectNotes.length;
  const s = project.stats;

  return (
    <div className="max-w-6xl">
      <SubHeader title={project.name} subtitle={project.client || undefined} back="/projects" backLabel="Projects" right={<AddTaskButton project={project.name} />} />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1.7fr)_minmax(0,_1fr)] gap-6 items-start">
        <div className="space-y-5">
          <ProjectHeader project={project} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Open" value={s.open} />
            <Stat label="Overdue" value={s.overdue} tone={s.overdue ? 'text-red-600 dark:text-red-400' : ''} />
            <Stat label="Done this week" value={s.doneThisWeek} tone="text-green-600 dark:text-green-400" />
            <Stat label="Complete" value={`${s.completion}%`} sub={`${s.done}/${s.done + s.open}`} />
          </div>

          <QuickAddBar defaults={{ project: project.name }} className="hidden md:block" />

          <section className="space-y-1.5">
            <h2 className={`${H2} px-1 md:px-0`}>Open</h2>
            <TaskList tasks={open} showProject={false} empty="Nothing open. Tap + to add a task." />
          </section>
          <section className="space-y-1.5">
            <h2 className={`${H2} px-1 md:px-0`}>Recently finished</h2>
            <TaskList tasks={done} showProject={false} empty="Nothing finished yet." />
          </section>
        </div>
        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className={`${H2} px-1 md:px-0`}>Notes</h2>
            <NewNoteButton project={project.id} label="New note" className="h-11 px-4 text-sm rounded-xl md:h-7 md:px-2 md:text-xs md:rounded-md" />
          </div>
          {projectNotes.length ? (
            <ul className="rounded-2xl md:rounded-lg border border-border/70 md:border-border divide-y divide-border/60 md:divide-border bg-card overflow-hidden">
              {projectNotes.map(n => (
                <li key={n.id}>
                  <Link href={`/notes/${n.id}`} className="flex items-center gap-3 md:items-start md:gap-2 px-4 md:px-3 py-3 md:py-2 min-h-14 md:min-h-0 hover:bg-muted/50 active:bg-muted/60">
                    <FileText className="w-4 h-4 md:w-3.5 md:h-3.5 md:mt-0.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[16px] md:text-sm font-medium truncate">{n.title}</div>
                      <div className="text-sm md:text-xs text-muted-foreground truncate">{n.firstLine || 'Empty'} · {fmtAgo(n.updatedAt)}</div>
                    </div>
                    <ChevronRight className="md:hidden w-4 h-4 text-muted-foreground/40" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground rounded-2xl md:rounded-none border border-border/70 md:border-0 bg-card md:bg-transparent px-4 py-4 md:p-0">
              No project notes. Ideas, client terms and things to raise later go here.
            </p>
          )}
          {otherNotes > 0 && (
            <Link href={`/notes?project=${project.id}&state=all`} className="flex items-center min-h-11 md:min-h-0 px-1 md:px-0 text-sm md:text-xs text-muted-foreground hover:text-foreground">
              + {otherNotes} task or archived notes →
            </Link>
          )}
          <h2 className={`${H2} px-1 md:px-0 pt-3`}>Activity</h2>
          <ActivityTimeline items={activity} showTask />
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: number | string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card px-3 py-2.5 md:py-2">
      <div className="text-xs md:text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-2xl md:text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
        {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}
