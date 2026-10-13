import { notFound } from 'next/navigation';
import { getProjectWithStats } from '@/lib/data/projects';
import { listActivity, listTasks } from '@/lib/data/tasks';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';
import { ProjectHeader } from './project-header';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { listNotes } from '@/lib/data/notes';
import { NewNoteButton } from '@/components/new-note-button';
import { fmtAgo } from '@/lib/format';

type Props = { params: Promise<{ id: string }> };

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
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1.7fr)_minmax(0,_1fr)] gap-6 items-start max-w-6xl">
      <div className="space-y-5">
        <ProjectHeader project={project} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</h2>
          <NewNoteButton project={project.id} label="New" className="h-7 px-2 text-xs" />
        </div>
        {projectNotes.length ? (
          <ul className="rounded-lg border border-border divide-y divide-border bg-card">
            {projectNotes.map(n => (
              <li key={n.id}>
                <Link href={`/notes/${n.id}`} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/50">
                  <FileText className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{n.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{n.firstLine || 'Empty'} · {fmtAgo(n.updatedAt)}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No project notes. Ideas, client terms and things to raise later go here.</p>
        )}
        {otherNotes > 0 && (
          <Link href={`/notes?project=${project.id}&state=all`} className="block text-xs text-muted-foreground hover:text-foreground">
            + {otherNotes} task or archived notes →
          </Link>
        )}
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-3">Activity</h2>
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
