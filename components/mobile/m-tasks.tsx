'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { MODES } from '@/lib/modes';
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
const DUE_OPTS: { key: string; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'today_or_overdue', label: 'Today + overdue' },
  { key: 'this_week', label: 'This week' },
  { key: 'next_7_days', label: 'Next 7 days' },
  { key: 'no_date', label: 'No date' },
];
type Filters = { project: string; mode: string; due: string; q: string };
type Proj = { id: string; name: string };
const PRIOS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const PRIO_LABEL: Record<Priority, string> = { P1: 'P1 · must ship', P2: 'P2', P3: 'P3', P4: 'P4 · backlog' };

/**
 * Phone task list. Project / mode / due / q live in the URL (same keys as the desktop board, so
 * /board?due=overdue works); segments and the search box filter instantly on the device.
 * Every row has a status / priority / due / mode sheet (long-press or the ... button).
 */
export function MobileTasks({ tasks, projects, noteTaskIds, filters }: { tasks: Task[]; projects: Proj[]; noteTaskIds: string[]; filters: Filters }) {
  const { today } = useApp();
  const router = useRouter();
  const notes = useMemo(() => new Set(noteTaskIds), [noteTaskIds]);
  const [seg, setSeg] = useState<Seg>('open');
  const [sheet, setSheet] = useState(false);
  const [q, setQ] = useState(filters.q);
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const project = filters.project || null;

  useEffect(() => () => void (qTimer.current && clearTimeout(qTimer.current)), []);

  function setFilter(key: keyof Filters, value: string, replace = false) {
    // Read the live URL: the debounced search fires later, and a stale `params` would undo a filter picked since.
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const url = `/board${next.size ? '?' + next : ''}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }

  function clearFilters() {
    const next = new URLSearchParams(window.location.search);
    ['project', 'mode', 'due'].forEach(k => next.delete(k));
    router.push(`/board${next.size ? '?' + next : ''}`, { scroll: false });
  }

  function onSearch(v: string) {
    setQ(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setFilter('q', v.trim(), true), 450);
  }

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    return tasks.filter(t => {
      if (needle && !t.title.toLowerCase().includes(needle) && String(t.ref) !== needle && !t.tags.some(g => g.includes(needle))) return false;
      const open = t.status !== 'Done' && t.status !== 'Dropped';
      if (seg === 'done') return t.status === 'Done';
      if (!open) return false;
      if (seg === 'soon') return !!t.due && t.due <= addDays(today, 7);
      if (seg === 'waiting') return t.status === 'Blocked' || t.dependsOn.length > 0;
      return true;
    });
  }, [tasks, seg, q, today]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) if (t.status !== 'Done' && t.status !== 'Dropped' && t.projectId) c[t.projectId] = (c[t.projectId] ?? 0) + 1;
    return c;
  }, [tasks]);

  const projName = (id: string) => projects.find(p => p.id === id)?.name ?? 'Project';
  const dueLabel = DUE_OPTS.find(d => d.key === filters.due)?.label ?? filters.due;
  const nFilters = [filters.project, filters.mode, filters.due].filter(Boolean).length;

  const row = (t: Task) => <MTaskRow key={t.id} task={t} hasNote={notes.has(t.id)} showProject={!project} />;

  return (
    <div>
      <MobileHeader title="Tasks" subtitle={`${list.length} ${seg === 'done' ? 'done this week' : 'shown'}`} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={q}
            onChange={e => onSearch(e.target.value)}
            placeholder="Search tasks or #ref"
            enterKeyHint="search"
            className="w-full h-11 rounded-xl bg-muted/70 pl-9 pr-11 text-[16px] outline-none placeholder:text-muted-foreground"
          />
          {q && (
            <button
              onClick={() => {
                setQ('');
                setFilter('q', '', true);
              }}
              className="absolute right-0 top-0 w-11 h-11 flex items-center justify-center text-muted-foreground"
              aria-label="Clear"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          onClick={() => setSheet(true)}
          aria-label="Filters"
          className={cn('relative w-11 h-11 shrink-0 rounded-xl flex items-center justify-center', nFilters ? 'bg-foreground text-background' : 'bg-muted/70 text-foreground')}
        >
          <SlidersHorizontal className="w-5 h-5" />
          {nFilters > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center">{nFilters}</span>
          )}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-muted/70 p-1">
        {SEGS.map(s => (
          <button
            key={s.key}
            onClick={() => setSeg(s.key)}
            className={cn('h-11 rounded-lg text-[13px] font-medium transition-colors', seg === s.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
          >
            {s.label}
          </button>
        ))}
      </div>

      {nFilters > 0 && (
        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.project && (
            <Chip on onClick={() => setFilter('project', '')}>
              {projName(filters.project)} <X className="inline w-3.5 h-3.5 -mr-1" />
            </Chip>
          )}
          {filters.mode && (
            <Chip on onClick={() => setFilter('mode', '')}>
              {filters.mode} <X className="inline w-3.5 h-3.5 -mr-1" />
            </Chip>
          )}
          {filters.due && (
            <Chip on onClick={() => setFilter('due', '')}>
              {dueLabel} <X className="inline w-3.5 h-3.5 -mr-1" />
            </Chip>
          )}
        </div>
      )}

      {list.length === 0 ? (
        <p className="mt-12 text-center text-sm text-muted-foreground">{q || nFilters ? 'No tasks match.' : seg === 'done' ? 'Nothing finished this week yet.' : 'Nothing here.'}</p>
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

      {sheet && <FilterSheet filters={filters} projects={projects} counts={counts} onPick={(k, v) => setFilter(k, v)} onClear={clearFilters} onClose={() => setSheet(false)} />}
    </div>
  );
}

function FilterSheet({ filters, projects, counts, onPick, onClear, onClose }: { filters: Filters; projects: Proj[]; counts: Record<string, number>; onPick: (k: keyof Filters, v: string) => void; onClear: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  const any = filters.project || filters.mode || filters.due;
  // Portalled to <body>: inside <main> (z-10) the tab bar (z-40) would cover the Show tasks button.
  return createPortal(
    <div className="md:hidden fixed inset-0 z-50" data-sheet>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-background shadow-2xl animate-in slide-in-from-bottom duration-200"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="mx-auto mt-2.5 mb-1 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        <div className="flex items-center justify-between px-4">
          <span className="text-base font-semibold text-foreground">Filters</span>
          <div className="flex items-center">
            {any && (
              <button
                onClick={onClear}
                className="h-11 px-3 text-sm font-medium text-blue-600 dark:text-blue-400"
              >
                Clear all
              </button>
            )}
            <button onClick={onClose} className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <FGroup label="Due date">
          {DUE_OPTS.map(d => (
            <Chip key={d.key} on={filters.due === d.key} onClick={() => onPick('due', filters.due === d.key ? '' : d.key)}>
              {d.label}
            </Chip>
          ))}
        </FGroup>
        <FGroup label="Mode">
          {MODES.map(m => (
            <Chip key={m.name} on={filters.mode === m.name} onClick={() => onPick('mode', filters.mode === m.name ? '' : m.name)}>
              {m.name}
            </Chip>
          ))}
        </FGroup>
        <FGroup label="Project">
          {projects.map(p => (
            <Chip key={p.id} on={filters.project === p.id} onClick={() => onPick('project', filters.project === p.id ? '' : p.id)}>
              {p.name} {counts[p.id] ? <span className="opacity-60">{counts[p.id]}</span> : null}
            </Chip>
          ))}
        </FGroup>
        <div className="px-4 pt-4">
          <button onClick={onClose} className="w-full h-12 rounded-2xl bg-foreground text-background text-base font-semibold active:scale-[0.98] transition-transform">
            Show tasks
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-2 px-4">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 h-11 px-4 rounded-full border text-sm font-medium whitespace-nowrap active:scale-95 transition-transform',
        on ? 'bg-foreground text-background border-foreground' : 'border-border text-foreground bg-background',
      )}
    >
      {children}
    </button>
  );
}
