'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarDays, CheckCircle2, ChevronDown, ClipboardPaste, Flame, LayoutList, Zap } from 'lucide-react';
import type { FiverrRitualLog, Task } from '@/lib/types';
import { addDays } from '@/lib/dates';
import { getCurrentBlock, type ScheduleBlock } from '@/lib/schedule';
import { getBlockColor } from '@/lib/modes';
import { RITUAL_MODE_MAP } from '@/lib/ritual-mode-map';
import { MobileImport } from './m-import';
import { MobileDayPlan } from './m-day-plan';
import { FiverrRitualCard } from '@/components/fiverr-ritual-card';
import { cn } from '@/lib/utils';
import { useApp } from '../app-context';
import { MobileHeader } from './tab-bar';
import { MSection, MTaskRow } from './m-task-row';

const RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const byPrio = (a: Task, b: Task) => RANK[a.priority] - RANK[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9') || a.ref - b.ref;
const FLEX_KEY = 'workos-flex-override'; // same key as desktop
type Wd = 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
const WD_KEYS = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;

/** Phone home: day controls, NOW block, what's late, today, moving, stuck, next, schedule and Fiverr ritual. */
export function MobileToday({
  dayName,
  tasks,
  waiting,
  noteTaskIds,
  isNaturallyWeekend = false,
  weekday = null,
  schedule = [],
  todayRitualLog = null,
}: {
  dayName: string;
  tasks: Task[];
  waiting: Record<string, string[]>;
  noteTaskIds: string[];
  isNaturallyWeekend?: boolean;
  weekday?: Wd | null;
  schedule?: ScheduleBlock[];
  todayRitualLog?: FiverrRitualLog | null;
}) {
  const { today } = useApp();
  const notes = new Set(noteTaskIds);
  const seen = new Set<string>();
  const take = (list: Task[]) => list.filter(t => !seen.has(t.id) && (seen.add(t.id), true));

  const [flexOverride, setFlexOverride] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dayPlanOpen, setDayPlanOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read localStorage after hydration
      setFlexOverride(localStorage.getItem(FLEX_KEY) === 'true');
    } catch {}
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  function toggleFlex() {
    const next = !flexOverride;
    setFlexOverride(next);
    try {
      localStorage.setItem(FLEX_KEY, String(next));
    } catch {}
  }

  const isFlexDay = isNaturallyWeekend ? !flexOverride : flexOverride;
  const effectiveWeekday: Wd = weekday ?? 'mon';
  const liveWeekday = now ? (WD_KEYS[now.getDay()] ?? (isNaturallyWeekend && !isFlexDay ? 'mon' : null)) : null;
  const liveBlock = now && !isFlexDay ? getCurrentBlock(now, true) : null;
  const rawBlockMode = liveBlock && liveWeekday ? liveBlock.modes[liveWeekday] : null;
  const nowMode: string | null = rawBlockMode ? (rawBlockMode in RITUAL_MODE_MAP ? RITUAL_MODE_MAP[rawBlockMode] || null : rawBlockMode) : null;
  const accent = rawBlockMode ? getBlockColor(rawBlockMode) : null;
  const nowTasks = nowMode ? tasks.filter(t => t.mode === nowMode).sort(byPrio) : [];

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

      <div className="grid grid-cols-3 gap-2">
        <Action onClick={() => setDayPlanOpen(true)} icon={<LayoutList className="w-4 h-4" />}>
          Day plan
        </Action>
        <Action onClick={() => setImportOpen(true)} icon={<ClipboardPaste className="w-4 h-4" />}>
          Import
        </Action>
        <Action
          onClick={toggleFlex}
          on={isFlexDay}
          icon={<CalendarDays className="w-4 h-4" />}
          label={isFlexDay ? 'Flex day: tap for work day' : 'Work day: tap for flex day'}
        >
          {isFlexDay ? 'Flex day' : 'Work day'}
        </Action>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? 'text-red-600 dark:text-red-400' : undefined} onClick={() => jump('m-overdue')} />
        <Stat label="Due today" value={dueToday.length} onClick={() => jump('m-today')} />
        <Stat label="In progress" value={inProgress.length} tone="text-blue-600 dark:text-blue-400" onClick={() => jump('m-progress')} />
      </div>

      {isFlexDay ? (
        <div className="mt-4 rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
          Flex day: no fixed schedule. <Link href="/recovery" className="underline font-medium">Recovery playbook</Link>
        </div>
      ) : accent && liveBlock ? (
        <Collapse
          className="mt-4"
          defaultOpen
          color={accent.hex}
          head={
            <>
              <Zap className="w-4 h-4 shrink-0" style={{ color: accent.hex }} />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-[13px] font-bold truncate" style={{ color: accent.hex }}>
                  NOW · {liveBlock.block}
                </div>
                <div className="text-[12px] text-muted-foreground truncate">
                  {rawBlockMode}
                  {nowMode && nowMode !== rawBlockMode ? ` → ${nowMode}` : ''} · {liveBlock.start}–{liveBlock.end}
                </div>
              </div>
            </>
          }
        >
          <p className="px-4 pb-3 text-[13px] leading-relaxed text-muted-foreground">{liveBlock.notes}</p>
          {!nowMode ? (
            <p className="px-4 pb-4 text-sm italic text-muted-foreground">{rawBlockMode} block, no tasks tracked here.</p>
          ) : nowTasks.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No active tasks in {nowMode}.</p>
          ) : (
            <div className="divide-y divide-border/60 border-t border-border/60 bg-card">{nowTasks.map(t => row(t))}</div>
          )}
        </Collapse>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">No active block right now.</div>
      )}

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
            <Link href="/tasks" className="mt-4 flex min-h-11 items-center justify-center text-sm text-muted-foreground active:opacity-60">
              {rest} more open in Tasks →
            </Link>
          )}
        </>
      )}

      <section className="mt-5 space-y-3">
        <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Routine</h2>
        {!isFlexDay && schedule.length > 0 && (
          <Collapse
            head={
              <>
                <CalendarDays className="w-4 h-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-left text-[15px] font-medium text-foreground">Schedule</span>
              </>
            }
          >
            <div className="px-2 pb-2">
              {schedule.map((blk, i) => {
                const modeName = blk.modes[effectiveWeekday];
                const color = getBlockColor(modeName);
                const active = liveBlock?.block === blk.block;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 min-h-11 px-2 rounded-xl"
                    style={active ? { backgroundColor: color.hex + '18', outline: `1.5px solid ${color.hex}50` } : undefined}
                  >
                    <span className="font-mono text-[12px] text-muted-foreground w-[5.5rem] shrink-0 tabular-nums">
                      {blk.start}–{blk.end}
                    </span>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color.hex }} />
                    <span className="text-[14px] font-medium text-foreground truncate flex-1">{modeName}</span>
                    {active && (
                      <span className="text-[11px] font-bold" style={{ color: color.hex }}>
                        NOW
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </Collapse>
        )}
        <Collapse
          color="#FACC15"
          head={
            <>
              <Flame className="w-4 h-4 shrink-0" style={{ color: '#FACC15' }} />
              <span className="flex-1 text-left text-[15px] font-medium text-foreground">Fiverr ritual</span>
              <span className="text-[12px] text-muted-foreground">{todayRitualLog ? `${todayRitualLog.bidsPlaced} bids` : 'not logged'}</span>
            </>
          }
        >
          <div className="px-3 pb-3 [&_input]:text-[16px] [&_textarea]:text-[16px] [&_button]:min-h-11">
            <FiverrRitualCard todayLog={todayRitualLog} />
          </div>
        </Collapse>
      </section>

      <MobileImport open={importOpen} onClose={() => setImportOpen(false)} />
      <MobileDayPlan open={dayPlanOpen} onClose={() => setDayPlanOpen(false)} allTasks={tasks} weekday={effectiveWeekday} />
    </div>
  );
}

/** Tappable card whose body folds away. */
function Collapse({ head, children, defaultOpen = false, color, className }: { head: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; color?: string; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn('rounded-2xl border bg-card overflow-hidden', !color && 'border-border/70', className)}
      style={color ? { borderColor: color + '70', backgroundColor: color + '10' } : undefined}
    >
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full min-h-[52px] flex items-center gap-2.5 px-4 py-2 active:bg-muted/50">
        {head}
        <ChevronDown className={cn('w-4 h-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function Action({ onClick, icon, children, on, label }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode; on?: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        'min-w-0 h-11 px-2 rounded-full border text-[13px] font-medium flex items-center justify-center gap-1.5 whitespace-nowrap active:scale-95 transition-transform',
        on ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400' : 'border-border bg-background text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
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
