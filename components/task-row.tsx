'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Circle, GitBranch, ListChecks, Repeat, TrendingUp } from 'lucide-react';
import { completeTaskAction, updateTaskAction } from '@/app/actions';
import { getBlockColor } from '@/lib/modes';
import { fmtDue, fmtMins } from '@/lib/format';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';
import { PrioritySelect, StatusSelect } from './inline-selects';
import { ProgressDialog } from './progress-dialog';
import { MTaskRow } from './mobile/m-task-row';

type Props = {
  task: Task;
  showProject?: boolean;
  showMode?: boolean;
  /** extra line under the title (e.g. blocked reason) */
  hint?: React.ReactNode;
};

export function TaskRow({ task, showProject = true, showMode = true, hint }: Props) {
  const { today, projectName } = useApp();
  const router = useRouter();
  const prevStatus = task.status;
  const [pending, start] = useTransition();
  const [progressOpen, setProgressOpen] = useState(false);
  const closed = task.status === 'Done' || task.status === 'Dropped';
  const overdue = !!task.due && task.due < today && !closed;
  const project = showProject ? projectName(task.projectId) : null;
  const modeColor = task.mode ? getBlockColor(task.mode).hex : null;
  const checklistDone = task.checklist.filter(i => i.done).length;

  function save(patch: Parameters<typeof updateTaskAction>[1], msg: string) {
    start(async () => {
      const res = await updateTaskAction(task.id, patch);
      if (res.ok) toast.success(msg);
      else toast.error(res.error);
    });
  }

  function complete() {
    start(async () => {
      const res = await completeTaskAction(task.id);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`#${task.ref} done${res.data.nextRef ? ` · next is #${res.data.nextRef}` : ''}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            const u = await updateTaskAction(task.id, { status: prevStatus });
            if (u.ok) router.refresh();
            else toast.error(u.error);
          },
        },
      });
    });
  }

  return (
    <div className={cn('group flex items-start gap-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-muted/60', pending && 'opacity-60', closed && 'opacity-50')}>
      <button
        onClick={complete}
        disabled={closed || pending}
        title={closed ? task.status : 'Mark done'}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-green-500 disabled:hover:text-muted-foreground"
      >
        {task.status === 'Done' ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <Circle className="w-4 h-4" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-mono text-muted-foreground/70 shrink-0">#{task.ref}</span>
          {showMode && modeColor && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: modeColor }} title={task.mode ?? ''} />}
          <Link
            href={`/tasks/${task.ref}`}
            className={cn('text-sm truncate hover:underline underline-offset-2', closed ? 'line-through text-muted-foreground' : 'text-foreground')}
          >
            {task.title}
          </Link>
          {task.recurrence && <Repeat className="w-3 h-3 text-muted-foreground shrink-0" aria-label="Recurring" />}
          {task.dependsOn.length > 0 && <GitBranch className="w-3 h-3 text-muted-foreground shrink-0" aria-label="Has dependencies" />}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground flex-wrap">
          {project && (
            <Link href={`/projects/${task.projectId}`} className="hover:text-foreground truncate max-w-[160px]">
              {project}
            </Link>
          )}
          {task.tags.map(t => (
            <span key={t} className="text-muted-foreground/80">
              #{t}
            </span>
          ))}
          {task.checklist.length > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <ListChecks className="w-3 h-3" />
              {checklistDone}/{task.checklist.length}
            </span>
          )}
          {task.status === 'Blocked' && task.blockedReason && <span className="text-red-600 dark:text-red-400 truncate max-w-[280px]">⛔ {task.blockedReason}</span>}
          {hint}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {!closed && (
          <button
            onClick={() => setProgressOpen(true)}
            className="flex items-center gap-1 h-6 px-1 rounded-md hover:bg-muted"
            title="Log progress"
          >
            <span className="w-10 h-1 rounded-full bg-muted overflow-hidden">
              <span className="block h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
            </span>
            <span className="text-[11px] font-mono text-muted-foreground w-7 text-right">{task.progress}%</span>
            <TrendingUp className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
        )}
        {task.estimateMins ? <span className="text-[11px] font-mono text-muted-foreground w-10 text-right">{fmtMins(task.estimateMins)}</span> : <span className="w-10" />}
        <span className={cn('text-xs w-16 text-right', overdue ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground')}>
          {fmtDue(task.due, today)}
        </span>
        <PrioritySelect value={task.priority} disabled={pending} onChange={p => save({ priority: p }, `#${task.ref} → ${p}`)} />
        <StatusSelect value={task.status} disabled={pending} className="w-[108px]" onChange={s => save({ status: s }, `#${task.ref} → ${s}`)} />
      </div>

      {progressOpen && <ProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </div>
  );
}

export function TaskList({ tasks, empty = 'No tasks.', ...rest }: { tasks: Task[]; empty?: string } & Omit<Props, 'task'>) {
  if (!tasks.length) return <div className="text-sm md:text-xs text-muted-foreground py-3 px-2">{empty}</div>;
  return (
    <>
      <div className="md:hidden rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
        {tasks.map(t => (
          <MTaskRow key={t.id} task={t} showProject={rest.showProject} hint={rest.hint} />
        ))}
      </div>
      <div className="hidden md:block space-y-0.5">
        {tasks.map(t => (
          <TaskRow key={t.id} task={t} {...rest} />
        ))}
      </div>
    </>
  );
}
