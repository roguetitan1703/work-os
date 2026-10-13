'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronRight, FileText, ListChecks, Repeat } from 'lucide-react';
import { completeTaskAction, updateTaskAction } from '@/app/actions';
import { fmtDue } from '@/lib/format';
import type { Priority, Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from '../app-context';

const PRIO_RING: Record<Priority, string> = {
  P1: 'border-red-500',
  P2: 'border-orange-400',
  P3: 'border-yellow-400',
  P4: 'border-muted-foreground/40',
};

/** Phone task row: big tap target to complete (with undo), whole row opens the task. */
export function MTaskRow({ task, showProject = true, hint, hasNote }: { task: Task; showProject?: boolean; hint?: React.ReactNode; hasNote?: boolean }) {
  const { today, projectName } = useApp();
  const router = useRouter();
  const [done, setDone] = useState(task.status === 'Done');
  const [, start] = useTransition();
  const closed = done || task.status === 'Dropped';
  const overdue = !!task.due && task.due < today && !closed;
  const project = showProject ? projectName(task.projectId) : null;
  const checklistDone = task.checklist.filter(i => i.done).length;
  const prevStatus = task.status;

  function toggle() {
    if (closed) return;
    navigator.vibrate?.(10);
    setDone(true);
    start(async () => {
      const res = await completeTaskAction(task.id);
      if (!res.ok) {
        setDone(false);
        return void toast.error(res.error);
      }
      toast.success(`Done: ${task.title}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            const u = await updateTaskAction(task.id, { status: prevStatus });
            if (u.ok) {
              setDone(false);
              router.refresh();
            } else toast.error(u.error);
          },
        },
      });
      setTimeout(() => router.refresh(), 1200);
    });
  }

  return (
    <div className={cn('flex items-stretch gap-1 transition-opacity duration-500', done && 'opacity-50')}>
      <button
        onClick={toggle}
        aria-label={closed ? task.status : `Complete ${task.title}`}
        className="w-12 shrink-0 flex items-start justify-center pt-3.5 active:scale-90 transition-transform"
      >
        <span
          className={cn(
            'w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center transition-colors',
            done ? 'bg-green-500 border-green-500' : PRIO_RING[task.priority],
          )}
        >
          {done && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
        </span>
      </button>
      <Link href={`/tasks/${task.ref}`} className="flex-1 min-w-0 flex items-center gap-2 py-3 pr-3 active:bg-muted/60 rounded-r-xl">
        <div className="flex-1 min-w-0">
          <div className={cn('text-[16px] leading-snug text-foreground', done && 'line-through text-muted-foreground')}>{task.title}</div>
          <div className="mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[13px] text-muted-foreground">
            {task.due && <span className={cn(overdue && 'text-red-600 dark:text-red-400 font-medium')}>{fmtDue(task.due, today)}</span>}
            {project && <span className="truncate max-w-[45vw]">{project}</span>}
            {task.status === 'In Progress' && <span className="text-blue-600 dark:text-blue-400">{task.progress}%</span>}
            {task.status === 'Blocked' && <span className="text-red-600 dark:text-red-400 truncate max-w-[60vw]">Blocked{task.blockedReason ? `: ${task.blockedReason}` : ''}</span>}
            {task.checklist.length > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <ListChecks className="w-3.5 h-3.5" />
                {checklistDone}/{task.checklist.length}
              </span>
            )}
            {task.recurrence && <Repeat className="w-3.5 h-3.5" />}
            {hasNote && <FileText className="w-3.5 h-3.5" />}
            {hint}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      </Link>
    </div>
  );
}

/** A titled group of rows on a card, iOS-settings style. */
export function MSection({ title, count, tone, children, empty }: { title: string; count?: number; tone?: string; children: React.ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  if (!hasRows && !empty) return null;
  return (
    <section className="mt-5">
      <h2 className={cn('px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider', tone ?? 'text-muted-foreground')}>
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}
      </h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
        {hasRows ? children : <div className="px-4 py-4 text-sm text-muted-foreground">{empty}</div>}
      </div>
    </section>
  );
}
