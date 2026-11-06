'use client';

import Link from '@/components/intent-link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Check, CornerDownRight, ListTree, Plus, X } from 'lucide-react';
import { createTaskAction, updateTaskAction } from '@/app/actions';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ResponsiveSheet } from './responsive-sheet';
import { useApp } from './app-context';

// Subtasks on rows and cards (docs/subtasks.md): a parent shows "3/8", a subtask shows the task it is part of.

/** "3/8": a parent's subtasks done of those counted (Dropped ones are left out). */
export function SubtaskChip({ task, className }: { task: Pick<Task, 'subtaskCount'>; className?: string }) {
  const c = task.subtaskCount;
  if (!c?.total) return null;
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} title={`${c.done} of ${c.total} subtasks done`} data-subtask-chip>
      <ListTree className="w-3 h-3" />
      {c.done}/{c.total}
    </span>
  );
}

/** "in <parent title>" under a subtask's title; a link to the parent unless the row itself is a link (phone rows). */
export function ParentLine({ task, link = true, className }: { task: Pick<Task, 'parentId' | 'parentRef' | 'parentTitle'>; link?: boolean; className?: string }) {
  if (!task.parentId) return null;
  const body = (
    <>
      <CornerDownRight className="w-3 h-3 shrink-0" />
      <span className="truncate">in {task.parentTitle ?? `#${task.parentRef}`}</span>
    </>
  );
  const cls = cn('inline-flex items-center gap-0.5 min-w-0 max-w-[220px]', className);
  return link ? (
    <Link href={`/tasks/${task.parentRef}`} className={cn(cls, 'hover:text-foreground')} data-parent-line>
      {body}
    </Link>
  ) : (
    <span className={cls} data-parent-line>
      {body}
    </span>
  );
}

/**
 * Completing a parent with open subtasks asks first: "Close the N open subtasks too?" (Close them / Leave them open).
 * ask(go) calls go(closeSubtasks) at once when nothing is open.
 */
export function useCloseSubtasks(task: Pick<Task, 'ref' | 'subtaskCount'>) {
  const [go, setGo] = useState<null | ((close: boolean) => void)>(null);
  const open = task.subtaskCount ? task.subtaskCount.total - task.subtaskCount.done : 0;
  const ask = (fn: (close: boolean) => void) => (open > 0 ? setGo(() => fn) : fn(false));
  const pick = (close: boolean) => {
    const fn = go;
    setGo(null);
    fn?.(close);
  };
  const sheet = go ? (
    <ResponsiveSheet title={`Close the ${open} open subtask${open === 1 ? '' : 's'} too?`} onClose={() => setGo(null)}>
      <div className="space-y-4 pt-1 pb-2" data-close-subtasks>
        <p className="text-[16px] md:text-sm text-foreground">
          #{task.ref} still has {open} open subtask{open === 1 ? '' : 's'}. You can mark {open === 1 ? 'it' : 'them'} done with it, or leave {open === 1 ? 'it' : 'them'} open.
        </p>
        <div className="flex gap-2">
          <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-medium border border-border text-foreground" onClick={() => pick(false)} data-leave-open>
            Leave them open
          </button>
          <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-semibold bg-foreground text-background" onClick={() => pick(true)} data-close-them>
            Close them
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  ) : null;
  return { ask, sheet };
}

/**
 * The task page's Subtasks section (desktop and phone): add one (title, Enter), tick it done, open it, take it out.
 * Not shown on a subtask (one level only).
 */
export function SubtasksSection({ task, subtasks, phone }: { task: Task; subtasks: Task[]; phone?: boolean }) {
  const { people, me } = useApp();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState('');
  if (task.parentId) return null;
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, msg?: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      if (msg) toast.success(msg);
      after?.();
    });
  const add = () => {
    const t = title.trim();
    if (!t) return;
    run(() => createTaskAction({ title: t, parent: task.id }), undefined, () => setTitle(''));
  };
  const c = task.subtaskCount;
  const label = `Subtasks${c?.total ? ` · ${c.done}/${c.total}` : ''}`;
  const rows = subtasks.map(k => {
    const done = k.status === 'Done';
    const closed = done || k.status === 'Dropped';
    const who = k.assigneeIds.map(id => (id === me ? 'You' : (people[id] ?? ''))).filter(Boolean).join(', ');
    const tick = () => run(() => updateTaskAction(k.id, { status: done ? 'Not Started' : 'Done' }), done ? `#${k.ref} reopened` : `#${k.ref} done`);
    const detach = () => run(() => updateTaskAction(k.id, { parent: null }), `#${k.ref} is now a task on its own`);
    return phone ? (
      <div key={k.id} className="flex items-center" data-subtask={k.ref}>
        <button onClick={tick} disabled={pending || k.status === 'Dropped'} aria-label={done ? `Reopen ${k.title}` : `Complete ${k.title}`} className="pl-4 pr-3 min-h-12 flex items-center shrink-0">
          <span className={cn('w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center', done ? 'bg-green-500 border-green-500' : 'border-muted-foreground/40')}>
            {done && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
          </span>
        </button>
        <Link href={`/tasks/${k.ref}`} className="flex-1 min-w-0 py-2 active:bg-muted/60">
          <div className={cn('text-[16px] truncate', closed && 'line-through text-muted-foreground')}>{k.title}</div>
          <div className="text-[13px] text-muted-foreground truncate">
            #{k.ref} · {k.status}
            {k.status === 'In Progress' ? ` ${k.progress}%` : ''}
            {who ? ` · ${who}` : ''}
          </div>
        </Link>
        <button onClick={detach} disabled={pending} aria-label={`Take #${k.ref} out of this task`} className="w-11 h-11 shrink-0 flex items-center justify-center text-muted-foreground active:text-red-500">
          <X className="w-4 h-4" />
        </button>
      </div>
    ) : (
      <div key={k.id} className="group flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/50" data-subtask={k.ref}>
        <input type="checkbox" checked={done} disabled={pending || k.status === 'Dropped'} onChange={tick} aria-label={done ? `Reopen ${k.title}` : `Complete ${k.title}`} />
        <Link href={`/tasks/${k.ref}`} className={cn('text-sm flex-1 min-w-0 truncate hover:underline', closed && 'line-through text-muted-foreground')}>
          <span className="font-mono text-[11px] text-muted-foreground mr-1">#{k.ref}</span>
          {k.title}
        </Link>
        {who && <span className="text-xs text-muted-foreground shrink-0">{who}</span>}
        <span className="text-xs text-muted-foreground shrink-0">{k.status === 'In Progress' ? `${k.progress}%` : k.status}</span>
        <button onClick={detach} disabled={pending} title="Take out of this task" aria-label={`Take #${k.ref} out of this task`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  });
  const input = (
    <input
      value={title}
      onChange={e => setTitle(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      }}
      enterKeyHint="done"
      placeholder="Add subtask…"
      aria-label="Add subtask"
      data-add-subtask
      className={phone ? 'flex-1 bg-transparent text-[16px] outline-none' : 'flex-1 h-7 bg-transparent text-sm outline-none placeholder:text-muted-foreground'}
    />
  );
  return phone ? (
    <section className="mt-5" data-subtasks>
      <h2 className="px-1 mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      {c?.total ? (
        <div className="mb-2 px-1 flex items-center gap-2 text-[13px] text-muted-foreground">
          <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
          </span>
          {c.done} of {c.total} done
        </div>
      ) : null}
      <div className="rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
        {rows}
        <div className="flex items-center gap-3 px-4 h-12">
          <Plus className="w-5 h-5 text-muted-foreground" />
          {input}
        </div>
      </div>
    </section>
  ) : (
    <section className="space-y-1.5" data-subtasks>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</h3>
      {c?.total ? <p className="text-xs text-muted-foreground px-1">{c.done} of {c.total} done · the progress above is their average</p> : null}
      <div className="space-y-0.5">{rows}</div>
      <div className="flex items-center gap-2 px-1">
        <Plus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        {input}
      </div>
    </section>
  );
}

/** On a subtask's page: the task it is part of. */
export function PartOf({ task, className }: { task: Task; className?: string }) {
  if (!task.parentId) return null;
  return (
    <Link href={`/tasks/${task.parentRef}`} className={cn('inline-flex items-center gap-1 min-w-0 hover:text-foreground', className)} data-part-of>
      <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Subtask of #{task.parentRef} {task.parentTitle}
      </span>
    </Link>
  );
}
