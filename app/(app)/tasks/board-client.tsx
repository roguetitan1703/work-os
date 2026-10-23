'use client';

import { PrivateBadge } from '@/components/private-badge';
import Link from '@/components/intent-link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ListChecks } from 'lucide-react';
import { updateTaskAction } from '@/app/actions';
import { useApp, useModes } from '@/components/app-context';
import { QuickAddBar } from '@/components/quick-add';
import { PrioritySelect } from '@/components/inline-selects';
import { fmtDue, PRIORITY_TEXT } from '@/lib/format';
import type { Status, Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ClaudeBadge } from '@/components/give-to-claude';

const COLUMNS: { status: Status; label: string; tone: string }[] = [
  { status: 'Not Started', label: 'To do', tone: 'bg-muted-foreground/40' },
  { status: 'In Progress', label: 'In progress', tone: 'bg-blue-500' },
  { status: 'Blocked', label: 'Blocked', tone: 'bg-red-500' },
  { status: 'Done', label: 'Done this week', tone: 'bg-green-500' },
];

const sel = 'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none dark:bg-input/30';

type Props = {
  tasks: Task[];
  projects: { id: string; name: string; private?: boolean }[];
  filters: { project: string; mode: string; due: string; q: string; assigned: string };
  focusSearch?: boolean;
};

export function BoardClient({ tasks, projects, filters, focusSearch = false }: Props) {
  const searchBox = useRef<HTMLInputElement>(null);
  const { modes, color } = useModes();
  useEffect(() => {
    if (focusSearch) searchBox.current?.focus();
  }, [focusSearch]);
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [q, setQ] = useState(filters.q);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/tasks${next.size ? '?' + next : ''}`);
  }

  function move(id: string, status: Status) {
    const t = tasks.find(x => x.id === id);
    if (!t || t.status === status) return;
    start(async () => {
      const res = await updateTaskAction(id, { status });
      if (res.ok) toast.success(`#${t.ref} → ${status}`);
      else toast.error(res.error);
    });
  }

  const projectName = projects.find(p => p.id === filters.project)?.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-foreground">Tasks</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={searchBox}
            data-task-search
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && setFilter('q', q)}
            placeholder="Search…"
            className={cn(sel, 'w-40')}
          />
          <button
            type="button"
            data-assigned-filter
            aria-pressed={!!filters.assigned}
            onClick={() => setFilter('assigned', filters.assigned ? '' : 'me')}
            className={cn(sel, 'px-3', filters.assigned && 'bg-foreground text-background border-foreground dark:bg-foreground')}
          >
            Assigned to me
          </button>
          <select className={sel} value={filters.project} onChange={e => setFilter('project', e.target.value)}>
            <option value="">All projects</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.private ? ' (private)' : ''}
              </option>
            ))}
          </select>
          <select className={sel} value={filters.mode} onChange={e => setFilter('mode', e.target.value)}>
            <option value="">All modes</option>
            {modes.map(m => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
          <select className={sel} value={filters.due} onChange={e => setFilter('due', e.target.value)}>
            <option value="">Any due date</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="today_or_overdue">Today + overdue</option>
            <option value="this_week">This week</option>
            <option value="next_7_days">Next 7 days</option>
            <option value="no_date">No date</option>
          </select>
        </div>
      </div>

      <QuickAddBar defaults={{ project: projectName }} />

      <div className={cn('grid grid-cols-4 gap-3 items-start', pending && 'opacity-70')}>
        {COLUMNS.map(col => {
          const items = tasks.filter(t => t.status === col.status);
          return (
            <div
              key={col.status}
              onDragOver={e => {
                e.preventDefault();
                setOver(col.status);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={e => {
                e.preventDefault();
                setOver(null);
                if (dragId) move(dragId, col.status);
                setDragId(null);
              }}
              className={cn('rounded-xl bg-muted/40 p-2 min-h-40 transition-colors', over === col.status && 'bg-muted ring-1 ring-border')}
            >
              <div className="flex items-center gap-2 px-1 pb-2">
                <span className={cn('w-2 h-2 rounded-full', col.tone)} />
                <span className="text-xs font-semibold text-foreground">{col.label}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map(t => (
                  <Card key={t.id} task={t} onDragStart={() => setDragId(t.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Card({ task, onDragStart }: { task: Task; onDragStart: () => void }) {
  const { today, projectName, isPrivateProject } = useApp();
  const { modes, color } = useModes();
  const [, start] = useTransition();
  const closed = task.status === 'Done' || task.status === 'Dropped';
  const overdue = !!task.due && task.due < today && !closed;
  const done = task.checklist.filter(i => i.done).length;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="rounded-lg border border-border bg-card p-2.5 space-y-1.5 cursor-grab active:cursor-grabbing shadow-xs"
      style={task.mode ? { borderLeft: `3px solid ${color(task.mode).hex}` } : undefined}
    >
      <div className="flex items-start gap-1.5">
        <Link href={`/tasks/${task.ref}`} className={cn('text-sm leading-snug flex-1 hover:underline', closed && 'line-through text-muted-foreground')}>
          {task.title}
        </Link>
        <PrioritySelect
          value={task.priority}
          className={cn('h-5 text-[11px]', PRIORITY_TEXT[task.priority])}
          onChange={p =>
            start(async () => {
              const r = await updateTaskAction(task.id, { priority: p });
              if (!r.ok) toast.error(r.error);
            })
          }
        />
      </div>
      {task.status === 'Blocked' && task.blockedReason && <p className="text-[11px] text-red-600 dark:text-red-400">⛔ {task.blockedReason}</p>}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
        <span className="font-mono">#{task.ref}</span>
        {task.projectId && <span className="truncate max-w-[110px]">{projectName(task.projectId)}{isPrivateProject(task.projectId) && <PrivateBadge compact className="ml-1" />}</span>}
        {task.due && <span className={overdue ? 'text-red-600 dark:text-red-400 font-medium' : ''}>{fmtDue(task.due, today)}</span>}
        <ClaudeBadge task={task} />
        {task.checklist.length > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <ListChecks className="w-3 h-3" />
            {done}/{task.checklist.length}
          </span>
        )}
      </div>
      {task.progress > 0 && !closed && (
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
        </div>
      )}
    </div>
  );
}
