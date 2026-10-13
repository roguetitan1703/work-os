'use client';

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import type { Task } from '@/lib/types';
import { addDays } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { useApp } from '../app-context';
import { MobileHeader } from './tab-bar';
import { MSection, MTaskRow } from './m-task-row';

const RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const byPrio = (a: Task, b: Task) => RANK[a.priority] - RANK[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9') || a.ref - b.ref;

/** Phone home: what's late, what's today, what's moving, what's stuck, what's next. */
export function MobileToday({ dayName, tasks, waiting, noteTaskIds }: { dayName: string; tasks: Task[]; waiting: Record<string, string[]>; noteTaskIds: string[] }) {
  const { today } = useApp();
  const notes = new Set(noteTaskIds);
  const seen = new Set<string>();
  const take = (list: Task[]) => list.filter(t => !seen.has(t.id) && (seen.add(t.id), true));

  const overdue = take(tasks.filter(t => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!)));
  const dueToday = take(tasks.filter(t => t.due === today).sort(byPrio));
  const inProgress = take(tasks.filter(t => t.status === 'In Progress').sort(byPrio));
  const blocked = take(tasks.filter(t => t.status === 'Blocked' || waiting[t.id]).sort(byPrio));
  const week = addDays(today, 7);
  const upNext = take(tasks.filter(t => t.priority === 'P1' || (t.due && t.due <= week)).sort(byPrio));
  // Everything else that's open, so Today is never empty while there is open work.
  const otherAll = take([...tasks].sort(byPrio));
  const OTHER_MAX = 15;
  const other = otherAll.slice(0, OTHER_MAX);
  const rest = otherAll.length - other.length;

  const row = (t: Task, extra?: React.ReactNode) => <MTaskRow key={t.id} task={t} hasNote={notes.has(t.id)} hint={extra} />;
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      <MobileHeader title="Today" subtitle={dayName} />
      <div className="grid grid-cols-3 gap-2 mt-1">
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? 'text-red-600 dark:text-red-400' : undefined} onClick={() => jump('m-overdue')} />
        <Stat label="Due today" value={dueToday.length} onClick={() => jump('m-today')} />
        <Stat label="In progress" value={inProgress.length} tone="text-blue-600 dark:text-blue-400" onClick={() => jump('m-progress')} />
      </div>

      {!tasks.length ? (
        <div className="mt-16 flex flex-col items-center text-center text-muted-foreground">
          <CheckCircle2 className="w-12 h-12 text-green-500 mb-3" />
          <div className="text-lg font-semibold text-foreground">All clear</div>
          <div className="text-sm">No open tasks. Tap + to add something.</div>
        </div>
      ) : (
        <>
          <div id="m-overdue" className="scroll-mt-24">
            <MSection title="Overdue" count={overdue.length} tone="text-red-600 dark:text-red-400">
              {overdue.map(t => row(t))}
            </MSection>
          </div>
          <div id="m-today" className="scroll-mt-24">
            <MSection title="Due today" count={dueToday.length}>
              {dueToday.map(t => row(t))}
            </MSection>
          </div>
          <div id="m-progress" className="scroll-mt-24">
            <MSection title="In progress" count={inProgress.length}>
              {inProgress.map(t => row(t))}
            </MSection>
          </div>
          <MSection title="Blocked / waiting" count={blocked.length}>
            {blocked.map(t => row(t, waiting[t.id] ? <span>waits on {waiting[t.id].join(', ')}</span> : undefined))}
          </MSection>
          <MSection title="Up next" count={upNext.length}>
            {upNext.map(t => row(t))}
          </MSection>
          <MSection title={upNext.length || overdue.length || dueToday.length || inProgress.length || blocked.length ? 'Also open' : 'Open'} count={otherAll.length}>
            {other.map(t => row(t))}
          </MSection>
          {rest > 0 && (
            <Link href="/board" className="mt-4 block text-center text-sm text-muted-foreground active:opacity-60">
              {rest} more open in Tasks →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone, onClick }: { label: string; value: number; tone?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl bg-card border border-border/70 px-3 py-2.5 text-left active:scale-[0.97] transition-transform">
      <div className={cn('text-2xl font-bold tabular-nums', tone ?? 'text-foreground')}>{value}</div>
      <div className="text-[12px] text-muted-foreground">{label}</div>
    </button>
  );
}
