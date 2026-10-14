"use client";

import { useState, useEffect } from "react";
import { Task, FiverrRitualLog } from "@/lib/types";
import { ScheduleBlock, getCurrentBlock } from "@/lib/schedule";
import { getBlockColor } from "@/lib/modes";
import { RITUAL_MODE_MAP } from "@/lib/ritual-mode-map";
import { PasteImportDialog } from "@/components/paste-import";
import { DayPlanDialog } from "@/components/day-plan-dialog";
import { Button } from "@/components/ui/button";
import { ClipboardPaste, CalendarDays, Zap, LayoutList, ChevronDown, ChevronRight } from "lucide-react";
import { FiverrRitualCard } from "@/components/fiverr-ritual-card";
import { TaskList, TaskRow } from "@/components/task-row";
import { QuickAddBar } from "@/components/quick-add";
import { StatsStrip } from "@/components/stats-strip";
import { useApp } from "@/components/app-context";
import { fmtMins } from "@/lib/format";
import type { Stats } from "@/lib/data/summary";
import type { Mode } from "@/lib/types";

const FLEX_KEY = "workos-flex-override";

function getWeekday(date: Date): "mon" | "tue" | "wed" | "thu" | "fri" | null {
  const keys = [null, "mon", "tue", "wed", "thu", "fri", null] as const;
  return keys[date.getDay()] ?? null;
}

const PRIORITY_COLOR: Record<string, string> = {
  P1: "text-red-500",
  P2: "text-orange-500",
  P3: "text-yellow-500",
  P4: "text-muted-foreground",
};

type Props = {
  dayName: string;
  isNaturallyWeekend: boolean;
  weekday: "mon" | "tue" | "wed" | "thu" | "fri" | null;
  schedule: ScheduleBlock[];
  openTasks: Task[];
  waiting: Record<string, string[]>;
  stats: Stats;
  todayRitualLog: FiverrRitualLog | null;
};

export function TodayClient({ dayName, isNaturallyWeekend, weekday, schedule, openTasks, waiting, stats, todayRitualLog }: Props) {
  const { today } = useApp();
  const [flexOverride, setFlexOverride] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dayPlanOpen, setDayPlanOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read localStorage after hydration
      setFlexOverride(localStorage.getItem(FLEX_KEY) === "true");
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
  const effectiveWeekday: "mon" | "tue" | "wed" | "thu" | "fri" = weekday ?? "mon";

  const liveWeekday = now ? (getWeekday(now) ?? (isNaturallyWeekend && !isFlexDay ? "mon" : null)) : null;
  const liveBlock = now && !isFlexDay ? getCurrentBlock(now, true) : null;
  const currentBlockName = liveBlock?.block ?? null;

  const rawBlockMode = liveBlock && liveWeekday ? liveBlock.modes[liveWeekday] : null;
  const nowMode: string | null = rawBlockMode
    ? (rawBlockMode in RITUAL_MODE_MAP ? RITUAL_MODE_MAP[rawBlockMode] || null : rawBlockMode)
    : null;

  const accentColor = rawBlockMode ? getBlockColor(rawBlockMode) : null;
  const nowTasks = nowMode ? openTasks.filter(t => t.mode === nowMode) : [];

  // Focus sections. Each task appears in the first section it qualifies for.
  const seen = new Set<string>();
  const take = (pred: (t: Task) => boolean) =>
    openTasks.filter(t => !seen.has(t.id) && pred(t)).map(t => (seen.add(t.id), t));
  const overdue = take(t => !!t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!));
  const dueToday = take(t => t.due === today);
  const inProgress = take(t => t.status === "In Progress");
  const blocked = take(t => t.status === "Blocked" || !!waiting[t.id]);
  const rest = openTasks.filter(t => !seen.has(t.id));
  const byPriority = (p: string) => rest.filter(t => t.priority === p);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Today</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{dayName}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleFlex}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              isFlexDay
                ? "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20"
                : "bg-background border-border text-muted-foreground hover:bg-muted"
            }`}
            title={isFlexDay ? "Flex day — click to show schedule" : "Work day — click to switch to flex"}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            {isFlexDay ? "Flex day" : "Work day"}
          </button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setDayPlanOpen(true)}>
            <LayoutList className="w-3.5 h-3.5" />
            Day Plan
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setImportOpen(true)}>
            <ClipboardPaste className="w-3.5 h-3.5" />
            Import
          </Button>
        </div>
      </div>

      <StatsStrip stats={stats} />
      <QuickAddBar defaults={{ mode: (nowMode as Mode | null) ?? undefined }} />

      <div className="grid grid-cols-[minmax(0,_1fr)_minmax(0,_2.2fr)] gap-5 items-start">
        {/* LEFT: compact schedule strip */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Schedule</p>
          {isFlexDay ? (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-3 text-xs text-blue-600 dark:text-blue-400">
              Flex day — no fixed schedule.{" "}
              <a href="/recovery" className="underline font-medium">Recovery tab</a> for playbook.
              {isNaturallyWeekend && <span className="ml-1 opacity-70">(Toggle above for weekday view.)</span>}
            </div>
          ) : (
            schedule.map((blk, i) => {
              const modeName = blk.modes[effectiveWeekday];
              const color = getBlockColor(modeName);
              const isActive = currentBlockName === blk.block;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-500 ${isActive ? "ring-1" : "hover:bg-muted/50"}`}
                  style={isActive ? { backgroundColor: color.hex + "18", outline: `1.5px solid ${color.hex}50` } : {}}
                >
                  <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 tabular-nums">
                    {blk.start}–{blk.end}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color.hex }} />
                  <span className="text-xs font-medium text-foreground truncate flex-1">
                    {modeName}
                    {isActive && <span className="ml-1.5 text-[10px] font-bold" style={{ color: color.hex }}>NOW</span>}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* RIGHT */}
        <div className="space-y-4">
          {!isFlexDay && accentColor && liveBlock ? (
            <section
              className="rounded-xl border-2 p-4 transition-all duration-700"
              style={{ borderColor: accentColor.hex, backgroundColor: accentColor.hex + "14" }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Zap className="w-3.5 h-3.5 shrink-0" style={{ color: accentColor.hex }} />
                  <span className="font-bold text-xs" style={{ color: accentColor.hex }}>
                    NOW — {liveBlock.block}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
                    style={{ backgroundColor: accentColor.hex + "25", color: accentColor.hex }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accentColor.hex }} />
                    {rawBlockMode}
                    {nowMode && nowMode !== rawBlockMode && <span className="opacity-70"> → {nowMode}</span>}
                  </span>
                </div>
                <span className="text-xs font-mono text-muted-foreground">{liveBlock.start}–{liveBlock.end}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{liveBlock.notes}</p>
              {!nowMode ? (
                <div className="text-xs text-muted-foreground text-center py-2 italic">{rawBlockMode} block — no tasks tracked here.</div>
              ) : nowTasks.length === 0 ? (
                <div
                  className="text-xs py-3 text-center rounded-lg border border-dashed"
                  style={{ borderColor: accentColor.hex + "50", color: accentColor.hex + "99" }}
                >
                  No active tasks in {nowMode}.
                </div>
              ) : (
                <TaskList tasks={nowTasks} showMode={false} />
              )}
            </section>
          ) : !isFlexDay ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              No active block right now.
            </div>
          ) : null}

          <FocusSection title="Overdue" tone="text-red-600 dark:text-red-400" tasks={overdue} />
          <FocusSection title="Due today" tasks={dueToday} />
          <FocusSection title="In progress" tone="text-blue-600 dark:text-blue-400" tasks={inProgress} />
          <FocusSection title="Blocked / waiting" tone="text-red-600 dark:text-red-400" tasks={blocked} waiting={waiting} />

          <FiverrRitualCard todayLog={todayRitualLog} />

          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Everything else open</p>
            <PriorityStack label="P1" tasks={byPriority("P1")} defaultOpen />
            <PriorityStack label="P2" tasks={byPriority("P2")} defaultOpen={byPriority("P1").length === 0} />
            <PriorityStack label="P3" tasks={byPriority("P3")} />
            <PriorityStack label="P4" tasks={byPriority("P4")} />
          </div>
        </div>
      </div>

      <PasteImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DayPlanDialog open={dayPlanOpen} onClose={() => setDayPlanOpen(false)} allTasks={openTasks} weekday={effectiveWeekday} />
    </div>
  );
}

function FocusSection({ title, tasks, tone, waiting }: { title: string; tasks: Task[]; tone?: string; waiting?: Record<string, string[]> }) {
  if (!tasks.length) return null;
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className={`text-xs font-semibold ${tone ?? "text-foreground"}`}>{title}</span>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="p-1">
        {tasks.map(t => (
          <TaskRow key={t.id} task={t} hint={waiting?.[t.id] ? <span>waiting on {waiting[t.id].join(", ")}</span> : undefined} />
        ))}
      </div>
    </section>
  );
}

function PriorityStack({ label, tasks, defaultOpen = false }: { label: string; tasks: Task[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (tasks.length === 0) return null;
  const totalMins = tasks.reduce((s, t) => s + (t.estimateMins ?? 0), 0);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span className={`font-bold text-xs font-mono ${PRIORITY_COLOR[label]}`}>{label}</span>
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">{fmtMins(totalMins)}</span>
      </button>
      {open && (
        <div className="border-t border-border p-1">
          <TaskList tasks={tasks} />
        </div>
      )}
    </div>
  );
}
