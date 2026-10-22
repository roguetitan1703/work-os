"use client";

import { useState } from "react";
import Link from "@/components/intent-link";
import { CalendarDays, ChevronDown, ChevronRight, ClipboardPaste, Flame, LayoutList, Zap } from "lucide-react";
import type { RoutineLog, Mode, Task } from "@/lib/types";
import type { Routine } from "@/lib/schedule";
import { PasteImportDialog } from "@/components/paste-import";
import { DayPlanDialog } from "@/components/day-plan-dialog";
import { MobileImport } from "@/components/mobile/m-import";
import { MobileDayPlan } from "@/components/mobile/m-day-plan";
import { MobileHeader } from "@/components/mobile/tab-bar";
import { MTaskRow } from "@/components/mobile/m-task-row";
import { Button } from "@/components/ui/button";
import { RoutineCard } from "@/components/routine-card";
import { TaskRow } from "@/components/task-row";
import { QuickAddBar } from "@/components/quick-add";
import { cn } from "@/lib/utils";
import { ClaudeCard, type ClaudeCardData } from "./claude-card";
import { useTodayModel, type Wd } from "./today-model";

type Props = {
  dayName: string;
  isNaturallyWeekend: boolean;
  weekday: Wd | null;
  openTasks: Task[];
  waiting: Record<string, string[]>;
  noteTaskIds: string[];
  claude: ClaudeCardData | null;
  /** The person's own daily routine card (lib/schedule.ts), if they have one, and today's log of it. */
  routine: Routine | null;
  routineLog: RoutineLog | null;
};

type Model = ReturnType<typeof useTodayModel>;
type Variant = "phone" | "desk";

const SHOW = 5;
const SHOW_PHONE = 3;
const ALSO_MAX = 15;

/** Phone and desktop render the same sections in the same order; only the layout and row type differ. */
export function TodayClient(props: Props) {
  return (
    <>
      <div className="md:hidden" data-variant="phone">
        <TodayView variant="phone" {...props} />
      </div>
      <div className="hidden md:block" data-variant="desk">
        <TodayView variant="desk" {...props} />
      </div>
    </>
  );
}

function TodayView({ variant, dayName, isNaturallyWeekend, weekday, openTasks, waiting, noteTaskIds, claude, routine, routineLog }: Props & { variant: Variant }) {
  const m = useTodayModel({ tasks: openTasks, waiting, isNaturallyWeekend, weekday });
  const phone = variant === "phone";
  const [importOpen, setImportOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const notes = new Set(noteTaskIds);

  const row = (t: Task, hint?: React.ReactNode) =>
    phone ? <MTaskRow key={t.id} task={t} hasNote={notes.has(t.id)} hint={hint} /> : <TaskRow key={t.id} task={t} hint={hint} />;
  const waitHint = (t: Task) => (waiting[t.id] ? <span>{phone ? "waits" : "waiting"} on {waiting[t.id].join(", ")}</span> : undefined);

  const attention = m.overdue.length + m.dueToday.length + m.inProgress.length + m.blocked.length;
  const sections = (
    <div className={phone ? "" : "space-y-4"}>
      {/* Phone: 2 overdue rows when something is due today, so its first row fits the first screen. */}
      <TaskSection phone={phone} title="Overdue" tone="text-red-600 dark:text-red-400" tasks={m.overdue} render={t => row(t)} empty="Nothing overdue." phoneLimit={m.dueToday.length ? 2 : SHOW_PHONE} />
      <TaskSection phone={phone} title="Due today" tasks={m.dueToday} render={t => row(t)} />
      <TaskSection phone={phone} title="In progress" tone="text-blue-600 dark:text-blue-400" tasks={m.inProgress} render={t => row(t)} />
      <TaskSection phone={phone} title="Blocked" tone="text-red-600 dark:text-red-400" tasks={m.blocked} render={t => row(t, waitHint(t))} />
      <TaskSection phone={phone} title="Assigned to you" tasks={m.assigned} render={t => row(t)} />
      {m.assignedTotal > 0 && (
        <Link href="/tasks?assigned=me" className={cn("flex items-center text-muted-foreground hover:text-foreground", phone ? "min-h-11 px-1 text-[14px]" : "text-xs")} data-assigned-link>
          {m.assignedTotal} assigned to you in Tasks ›
        </Link>
      )}
      {attention === 0 && openTasks.length > 0 && <p className={cn("text-muted-foreground", phone ? "mt-5 px-1 text-[15px]" : "text-sm")}>Nothing else needs attention today.</p>}
      {openTasks.length === 0 && <p className={cn("text-muted-foreground", phone ? "mt-5 px-1 text-[15px]" : "text-sm")}>No open tasks. {phone ? "Tap + to add one." : "Press N to add one."}</p>}
      <div className={cn("space-y-2", phone ? "mt-5" : "pt-1")}>
        <Fold phone={phone} title="Up next" count={m.upNext.length}>
          <RowList phone={phone}>{m.upNext.map(t => row(t))}</RowList>
        </Fold>
        <Fold phone={phone} title={attention || m.upNext.length ? "Also open" : "Open"} count={m.alsoOpen.length}>
          <RowList phone={phone}>{m.alsoOpen.slice(0, ALSO_MAX).map(t => row(t))}</RowList>
          {m.alsoOpen.length > ALSO_MAX && (
            <Link href="/tasks" className="flex min-h-11 items-center justify-center text-sm text-muted-foreground">
              {m.alsoOpen.length - ALSO_MAX} more open in Tasks ›
            </Link>
          )}
        </Fold>
        {routine && (
          <Fold phone={phone} title="Routine" icon={<Flame className="w-4 h-4" style={{ color: routine.color }} />} hint={routineLog ? `${routine.name}: ${routineLog.count}` : `${routine.name} not logged`}>
            <div className="p-2 [&_input]:text-[16px] [&_input]:min-h-11 md:[&_input]:min-h-0 md:[&_input]:text-sm [&_textarea]:text-[16px] md:[&_textarea]:text-sm [&_button]:min-h-11 md:[&_button]:min-h-0">
              <RoutineCard routine={routine} todayLog={routineLog} />
            </div>
          </Fold>
        )}
      </div>
    </div>
  );

  // Schedule and the work/flex day switch only mean something to someone with a schedule.
  const buttons = (
    <>
      {m.hasSchedule && (
        <HeaderBtn phone={phone} onClick={() => setPlanOpen(true)} icon={<LayoutList className="w-4 h-4" />}>
          Schedule
        </HeaderBtn>
      )}
      <HeaderBtn phone={phone} onClick={() => setImportOpen(true)} icon={<ClipboardPaste className="w-4 h-4" />}>
        Import
      </HeaderBtn>
      {m.hasSchedule && (
        <HeaderBtn
          phone={phone}
          onClick={m.toggleFlex}
          on={m.isFlexDay}
          icon={<CalendarDays className="w-4 h-4" />}
          label={m.isFlexDay ? "Flex day: switch to work day" : "Work day: switch to flex day"}
        >
          {m.isFlexDay ? "Flex day" : "Work day"}
        </HeaderBtn>
      )}
    </>
  );

  const dialogs = phone ? (
    <>
      <MobileImport open={importOpen} onClose={() => setImportOpen(false)} />
      <MobileDayPlan open={planOpen} onClose={() => setPlanOpen(false)} allTasks={openTasks} weekday={m.effectiveWeekday} />
    </>
  ) : (
    <>
      <PasteImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DayPlanDialog open={planOpen} onClose={() => setPlanOpen(false)} allTasks={openTasks} weekday={m.effectiveWeekday} />
    </>
  );

  if (phone) {
    return (
      <div>
        <MobileHeader title="Today" subtitle={dayName} />
        <div className={cn("grid gap-2", m.hasSchedule ? "grid-cols-3" : "grid-cols-1")}>{buttons}</div>
        <div className="mt-3 space-y-3">
          <NowLine m={m} row={row} />
          <ClaudeCard data={claude} />
        </div>
        {sections}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Today</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{dayName}</p>
        </div>
        <div className="flex items-center gap-2">{buttons}</div>
      </div>
      <QuickAddBar defaults={{ mode: (m.nowMode as Mode | null) ?? undefined }} />
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-5 items-start">
        <div className="min-w-0">{sections}</div>
        <div className="space-y-4 min-w-0">
          <ClaudeCard data={claude} />
          <NowNext m={m} row={row} />
        </div>
      </div>
      {dialogs}
    </div>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────

function HeaderBtn({ phone, onClick, icon, children, on, label }: { phone: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode; on?: boolean; label?: string }) {
  if (!phone) {
    return (
      <Button variant="outline" size="sm" className={cn("gap-1.5 text-xs", on && "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400")} onClick={onClick} aria-label={label}>
        {icon}
        {children}
      </Button>
    );
  }
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        "min-w-0 h-11 px-2 rounded-full border text-[14px] font-medium flex items-center justify-center gap-1.5 whitespace-nowrap active:scale-95 transition-transform",
        on ? "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400" : "border-border bg-background text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function RowList({ phone, children }: { phone: boolean; children: React.ReactNode }) {
  return <div className={cn(phone ? "divide-y divide-border/60" : "p-1")}>{children}</div>;
}

/** A titled task group: count in the heading, first few rows, "Show N more". Hidden when empty (unless `empty` is given). */
function TaskSection({ phone, title, tone, tasks, render, empty, phoneLimit = SHOW_PHONE }: { phone: boolean; title: string; tone?: string; tasks: Task[]; render: (t: Task) => React.ReactNode; empty?: string; phoneLimit?: number }) {
  const [all, setAll] = useState(false);
  if (!tasks.length && !empty) return null;
  const limit = phone ? phoneLimit : SHOW;
  const list = all ? tasks : tasks.slice(0, limit);
  const hidden = tasks.length - list.length;
  const more = cn("w-full flex items-center justify-center font-medium text-muted-foreground border-t border-border/60 hover:bg-muted/40 active:bg-muted/60", phone ? "min-h-11 text-[14px]" : "min-h-9 text-xs");
  return (
    <section className={phone ? "mt-4" : ""} data-section={title.toLowerCase().replace(/\s+/g, "-")}>
      <h2 className={cn("font-semibold uppercase tracking-wider", phone ? "px-1 mb-1.5 text-[13px]" : "mb-1.5 text-xs", tone ?? "text-muted-foreground")}>
        {title}
        <span className="ml-1.5 font-normal text-muted-foreground">{tasks.length}</span>
      </h2>
      <div className={cn("overflow-hidden bg-card border", phone ? "rounded-2xl border-border/70" : "rounded-lg border-border")}>
        {tasks.length === 0 ? (
          <p className={cn("text-muted-foreground", phone ? "px-4 py-3 text-[15px]" : "px-3 py-2 text-sm")}>{empty}</p>
        ) : (
          <RowList phone={phone}>{list.map(render)}</RowList>
        )}
        {hidden > 0 && (
          <button onClick={() => setAll(true)} className={more}>
            Show {hidden} more
          </button>
        )}
        {all && tasks.length > limit && (
          <button onClick={() => setAll(false)} className={more}>
            Show fewer
          </button>
        )}
      </div>
    </section>
  );
}

/** Collapsed group; the body is only rendered when open. Nothing renders if it has a count of 0. */
function Fold({ phone, title, count, icon, hint, children }: { phone: boolean; title: string; count?: number; icon?: React.ReactNode; hint?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <section className={cn("overflow-hidden border bg-card", phone ? "rounded-2xl border-border/70" : "rounded-lg border-border")} data-fold={title.toLowerCase().replace(/\s+/g, "-")}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className={cn("w-full flex items-center gap-2 px-4 text-left active:bg-muted/50 hover:bg-muted/30", phone ? "min-h-[48px]" : "min-h-10 px-3")}>
        <Chev className="w-4 h-4 shrink-0 text-muted-foreground" />
        {icon}
        <span className={cn("font-semibold uppercase tracking-wider text-muted-foreground", phone ? "text-[13px]" : "text-xs")}>{title}</span>
        {count !== undefined && <span className="text-xs text-muted-foreground">{count}</span>}
        {hint && <span className="ml-auto text-xs text-muted-foreground">{hint}</span>}
      </button>
      {open && <div className="border-t border-border/60">{children}</div>}
    </section>
  );
}

/** Phone: the current block as one line; tap to see its tasks (only those not already listed below). */
function NowLine({ m, row }: { m: Model; row: (t: Task) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const plain = "rounded-2xl border border-border/70 bg-card px-4 min-h-[52px] flex items-center text-[15px] text-muted-foreground";
  if (!m.hasSchedule) return null;
  if (m.isFlexDay)
    return (
      <div className={plain}>
        Flex day · no fixed schedule ·{" "}
        <Link href="/settings?section=help" className="underline ml-1 inline-flex items-center min-h-11">
          Recovery
        </Link>
      </div>
    );
  if (!m.liveBlock || !m.hex) return <div className={plain}>No active block right now</div>;
  const extra = m.nowTasks.length;
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: m.hex + "70", backgroundColor: m.hex + "10" }} data-section="now">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full min-h-[52px] flex items-center gap-2 px-4 text-left active:bg-muted/50">
        <Zap className="w-4 h-4 shrink-0" style={{ color: m.hex }} />
        <span className="min-w-0 flex-1 truncate text-[15px]">
          <span className="font-bold" style={{ color: m.hex }}>NOW</span> <span className="text-foreground">{m.liveBlock.block}</span> <span className="text-muted-foreground">· {m.rawBlockMode}</span>
        </span>
        <span className="text-xs text-muted-foreground shrink-0">{extra ? `${extra} to do` : ""}</span>
        <ChevronDown className={cn("w-4 h-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-border/60 bg-card">
          <p className="px-4 py-2 text-[13px] text-muted-foreground">{m.liveBlock.start}–{m.liveBlock.end} · {m.liveBlock.notes}</p>
          {!m.nowMode ? (
            <p className="px-4 pb-3 text-[15px] text-muted-foreground">{m.rawBlockMode} block, no tasks tracked here.</p>
          ) : extra === 0 ? (
            <p className="px-4 pb-3 text-[15px] text-muted-foreground">Nothing more in {m.nowMode} (the rest is listed below).</p>
          ) : (
            <div className="divide-y divide-border/60 border-t border-border/60">{m.nowTasks.map(t => row(t))}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Desktop right column: the current block (tap for its tasks) plus the next 3, and a link to the full schedule. */
function NowNext({ m, row }: { m: Model; row: (t: Task) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!m.hasSchedule) return null;
  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden" data-section="now-next">
      <div className="flex items-center justify-between px-3 min-h-10 border-b border-border/60">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Now &amp; next</h2>
        <Link href="/timetable" className="text-xs text-muted-foreground hover:text-foreground">
          Full schedule ›
        </Link>
      </div>
      {m.isFlexDay ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          Flex day, no fixed schedule. <Link href="/settings?section=help" className="underline">Recovery playbook</Link>
        </p>
      ) : (
        <>
          {m.liveBlock && m.hex ? (
            <div style={{ backgroundColor: m.hex + "14" }} data-section="now">
              <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-2 px-3 min-h-10 text-left hover:bg-muted/30">
                <Zap className="w-3.5 h-3.5 shrink-0" style={{ color: m.hex }} />
                <span className="flex-1 min-w-0 truncate text-sm">
                  <span className="font-bold text-xs" style={{ color: m.hex }}>NOW</span> {m.liveBlock.block} <span className="text-muted-foreground">· {m.rawBlockMode}</span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{m.liveBlock.start}–{m.liveBlock.end}</span>
                <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
              </button>
              {open && (
                <div className="border-t border-border/60 bg-card p-1">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">{m.liveBlock.notes}</p>
                  {!m.nowMode ? (
                    <p className="px-2 pb-2 text-xs text-muted-foreground italic">{m.rawBlockMode} block, no tasks tracked here.</p>
                  ) : m.nowTasks.length === 0 ? (
                    <p className="px-2 pb-2 text-xs text-muted-foreground">Nothing more in {m.nowMode} (the rest is listed on the left).</p>
                  ) : (
                    m.nowTasks.map(t => row(t))
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">No active block right now.</p>
          )}
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {m.nextBlocks.map(n => (
              <li key={n.block.start} className="flex items-center gap-2 px-3 min-h-9" data-next-block>
                <span className="font-mono text-xs text-muted-foreground w-11 tabular-nums">{n.block.start}</span>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: n.hex }} />
                <span className="text-xs text-foreground truncate flex-1">{n.mode}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[40%]">{n.block.block}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
