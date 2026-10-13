'use client';

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Priority, Task } from '@/lib/types';
import { addDays } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useApp } from '../app-context';
import { MobileHeader } from './tab-bar';
import { MSection, MTaskRow } from './m-task-row';

type Seg = 'open' | 'soon' | 'waiting' | 'done';
const SEGS: { key: Seg; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'soon', label: 'Due soon' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
];
const PRIOS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const PRIO_LABEL: Record<Priority, string> = { P1: 'P1 · must ship', P2: 'P2', P3: 'P3', P4: 'P4 · backlog' };

/** Phone task list: search, segments, project chips; filtering is instant on the device. */
export function MobileTasks({ tasks, projects, noteTaskIds }: { tasks: Task[]; projects: { id: string; name: string }[]; noteTaskIds: string[] }) {
  const { today } = useApp();
  const notes = useMemo(() => new Set(noteTaskIds), [noteTaskIds]);
  const [seg, setSeg] = useState<Seg>('open');
  const [project, setProject] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    return tasks.filter(t => {
      if (project && t.projectId !== project) return false;
      if (needle && !t.title.toLowerCase().includes(needle) && String(t.ref) !== needle && !t.tags.some(g => g.includes(needle))) return false;
      const open = t.status !== 'Done' && t.status !== 'Dropped';
      if (seg === 'done') return t.status === 'Done';
      if (!open) return false;
      if (seg === 'soon') return !!t.due && t.due <= addDays(today, 7);
      if (seg === 'waiting') return t.status === 'Blocked' || t.dependsOn.length > 0;
      return true;
    });
  }, [tasks, seg, project, q, today]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) if (t.status !== 'Done' && t.status !== 'Dropped' && t.projectId) c[t.projectId] = (c[t.projectId] ?? 0) + 1;
    return c;
  }, [tasks]);
  const shownProjects = projects.filter(p => counts[p.id]).sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));

  const row = (t: Task) => <MTaskRow key={t.id} task={t} hasNote={notes.has(t.id)} showProject={!project} />;

  return (
    <div>
      <MobileHeader title="Tasks" subtitle={`${list.length} ${seg === 'done' ? 'done this week' : 'shown'}`} />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search tasks or #ref"
          enterKeyHint="search"
          className="w-full h-11 rounded-xl bg-muted/70 pl-9 pr-9 text-[16px] outline-none placeholder:text-muted-foreground"
        />
        {q && (
          <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-muted-foreground" aria-label="Clear">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-muted/70 p-1">
        {SEGS.map(s => (
          <button
            key={s.key}
            onClick={() => setSeg(s.key)}
            className={cn('h-9 rounded-lg text-[13px] font-medium transition-colors', seg === s.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
          >
            {s.label}
          </button>
        ))}
      </div>

      {shownProjects.length > 0 && (
        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip on={!project} onClick={() => setProject(null)}>
            All
          </Chip>
          {shownProjects.map(p => (
            <Chip key={p.id} on={project === p.id} onClick={() => setProject(project === p.id ? null : p.id)}>
              {p.name} <span className="opacity-60">{counts[p.id]}</span>
            </Chip>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <p className="mt-12 text-center text-sm text-muted-foreground">{q || project ? 'No tasks match.' : seg === 'done' ? 'Nothing finished this week yet.' : 'Nothing here.'}</p>
      ) : seg === 'open' ? (
        PRIOS.map(p => {
          const group = list.filter(t => t.priority === p);
          return group.length ? (
            <MSection key={p} title={PRIO_LABEL[p]} count={group.length} tone={p === 'P1' ? 'text-red-600 dark:text-red-400' : undefined}>
              {group.map(row)}
            </MSection>
          ) : null;
        })
      ) : (
        <MSection title={SEGS.find(s => s.key === seg)!.label} count={list.length}>
          {(seg === 'soon' ? [...list].sort((a, b) => a.due!.localeCompare(b.due!)) : list).map(row)}
        </MSection>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 h-9 px-3.5 rounded-full border text-sm font-medium whitespace-nowrap active:scale-95 transition-transform',
        on ? 'bg-foreground text-background border-foreground' : 'border-border text-foreground bg-background',
      )}
    >
      {children}
    </button>
  );
}
