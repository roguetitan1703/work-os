"use client";

import { useState, useEffect } from "react";
import { Task } from "@/lib/types";
import { ScheduleBlock, getCurrentBlock } from "@/lib/schedule";
import { getBlockColor } from "@/lib/modes";
import { RITUAL_MODE_MAP } from "@/lib/ritual-mode-map";
import { PasteImportDialog } from "@/components/paste-import";
import { DayPlanDialog } from "@/components/day-plan-dialog";
import { PriorityBadge } from "@/components/priority-badge";
import { Button } from "@/components/ui/button";
import { ClipboardPaste, CalendarDays, Zap, LayoutList, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import { updateTask } from "@/app/actions";
import { FiverrRitualCard } from "@/components/fiverr-ritual-card";
import { toast } from "sonner";
import { useTransition } from "react";
import { format, parseISO } from "date-fns";
import { FiverrRitualLog } from "@/lib/types";

const FLEX_KEY = "workos-flex-override";

function getWeekday(date: Date): "mon" | "tue" | "wed" | "thu" | "fri" | null {
  const keys = [null, "mon", "tue", "wed", "thu", "fri", null] as const;
  return keys[date.getDay()] ?? null;
}

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
const PRIORITY_COLOR: Record<string, string> = {
  P1: "text-red-500",
  P2: "text-orange-500",
  P3: "text-yellow-500",
  P4: "text-muted-foreground",
};

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });
}

function fmtDate(d?: string) {
  if (!d) return null;
  try { return format(parseISO(d), "MMM d"); } catch { return null; }
}

function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

type Props = {
  dayName: string;
  isNaturallyWeekend: boolean;
  weekday: "mon" | "tue" | "wed" | "thu" | "fri" | null;
  schedule: ScheduleBlock[];
  allActiveTasks: Task[];
  todayRitualLog: FiverrRitualLog | null;
};

export function TodayClient({
  dayName,
  isNaturallyWeekend,
  weekday,
  schedule,
  allActiveTasks,
  todayRitualLog,
}: Props) {
  const [flexOverride, setFlexOverride] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dayPlanOpen, setDayPlanOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setFlexOverride(localStorage.getItem(FLEX_KEY) === "true");
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  function toggleFlex() {
    const next = !flexOverride;
    setFlexOverride(next);
    localStorage.setItem(FLEX_KEY, String(next));
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

  const nowTasks = nowMode ? sortTasks(allActiveTasks.filter(t => t.mode === nowMode)) : [];

  const p1 = sortTasks(allActiveTasks.filter(t => t.priority === "P1"));
  const p2 = sortTasks(allActiveTasks.filter(t => t.priority === "P2"));
  const p3 = sortTasks(allActiveTasks.filter(t => t.priority === "P3"));
  const p4 = sortTasks(allActiveTasks.filter(t => t.priority === "P4"));

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
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setDayPlanOpen(true)}
          >
            <LayoutList className="w-3.5 h-3.5" />
            Day Plan
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setImportOpen(true)}>
            <ClipboardPaste className="w-3.5 h-3.5" />
            Import
          </Button>
        </div>
      </div>

      {/* 2-column grid: schedule strip | NOW + task stacks */}
      <div className="grid grid-cols-[minmax(0,_1fr)_minmax(0,_1.5fr)] gap-5 items-start">

        {/* LEFT: compact schedule strip */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Schedule</p>
          {isFlexDay ? (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-3 text-xs text-blue-600 dark:text-blue-400">
              Flex day — no fixed schedule.{" "}
              <a href="/recovery" className="underline font-medium">Recovery tab</a> for playbook.
              {isNaturallyWeekend && (
                <span className="ml-1 opacity-70">(Toggle above for weekday view.)</span>
              )}
            </div>
          ) : (
            schedule.map((blk, i) => {
              const modeName = blk.modes[effectiveWeekday];
              const color = getBlockColor(modeName);
              const isActive = currentBlockName === blk.block;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-500 ${
                    isActive ? "ring-1" : "hover:bg-muted/50"
                  }`}
                  style={isActive ? {
                    backgroundColor: color.hex + "18",
                    outline: `1.5px solid ${color.hex}50`,
                  } : {}}
                >
                  <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 tabular-nums">
                    {blk.start}–{blk.end}
                  </span>
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: color.hex }}
                  />
                  <span className="text-xs font-medium text-foreground truncate flex-1">
                    {modeName}
                    {isActive && (
                      <span className="ml-1.5 text-[10px] font-bold" style={{ color: color.hex }}>NOW</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* RIGHT: NOW panel + priority stacks */}
        <div className="space-y-4">
          {/* NOW panel */}
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
                    {nowMode && nowMode !== rawBlockMode && (
                      <span className="opacity-70"> → {nowMode}</span>
                    )}
                  </span>
                </div>
                <span className="text-xs font-mono text-muted-foreground">{liveBlock.start}–{liveBlock.end}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{liveBlock.notes}</p>
              {!nowMode ? (
                <div className="text-xs text-muted-foreground text-center py-2 italic">
                  {rawBlockMode} block — no tasks tracked here.
                </div>
              ) : nowTasks.length === 0 ? (
                <div
                  className="text-xs py-3 text-center rounded-lg border border-dashed"
                  style={{ borderColor: accentColor.hex + "50", color: accentColor.hex + "99" }}
                >
                  No active tasks in {nowMode}.
                </div>
              ) : (
                <div className="space-y-0.5">
                  {nowTasks.map(task => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              )}
            </section>
          ) : !isFlexDay ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              No active block right now.
            </div>
          ) : null}

          {/* Fiverr ritual check-in */}
          <FiverrRitualCard todayLog={todayRitualLog} />

          {/* Priority stacks */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">All Active Tasks</p>
            <PriorityStack label="P1" tasks={p1} defaultOpen />
            <PriorityStack label="P2" tasks={p2} defaultOpen={p1.length === 0} />
            <PriorityStack label="P3" tasks={p3} />
            <PriorityStack label="P4" tasks={p4} />
          </div>
        </div>
      </div>

      <PasteImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DayPlanDialog
        open={dayPlanOpen}
        onClose={() => setDayPlanOpen(false)}
        allTasks={allActiveTasks}
        weekday={effectiveWeekday}
      />
    </div>
  );
}

function TaskRow({ task, showMode = false }: { task: Task; showMode?: boolean }) {
  const [, startTransition] = useTransition();
  const due = fmtDate(task.due);
  const isDone = task.status === "Done";
  const isBlocked = task.status === "Blocked";
  const isInProgress = task.status === "In Progress";
  const modeColor = getBlockColor(task.mode);

  function markDone() {
    startTransition(async () => {
      await updateTask(task.id, { status: "Done" });
      toast.success("Marked done.");
    });
  }

  return (
    <div className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${isDone ? "opacity-40" : "hover:bg-muted/60"}`}>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: modeColor.hex }}
      />
      {showMode && (
        <span
          className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{ backgroundColor: modeColor.hex + "18", color: modeColor.hex }}
        >
          {task.mode}
        </span>
      )}
      <span className={`text-sm flex-1 min-w-0 truncate ${isDone ? "line-through text-muted-foreground" : "text-foreground"}`}>
        {task.task}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {task.projectClient && (
          <span className="text-xs text-muted-foreground hidden group-hover:inline truncate max-w-[120px]">{task.projectClient}</span>
        )}
        <PriorityBadge priority={task.priority} />
        <span className="text-xs font-mono text-muted-foreground">{fmtMins(task.estimateMins)}</span>
        {due && <span className="text-xs text-muted-foreground">{due}</span>}
        {isBlocked && <span className="text-xs text-red-500 font-medium">blocked</span>}
        {isInProgress && <span className="text-xs text-blue-500 font-medium">in progress</span>}
      </div>
      {!isDone && (
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-green-500"
          onClick={markDone}
          title="Mark done"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function PriorityStack({
  label,
  tasks,
  defaultOpen = false,
}: {
  label: string;
  tasks: Task[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (tasks.length === 0) return null;

  const totalMins = tasks.reduce((s, t) => s + t.estimateMins, 0);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span className={`font-bold text-xs font-mono ${PRIORITY_COLOR[label]}`}>{label}</span>
        <span className="text-xs text-muted-foreground">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
        <span className="text-xs text-muted-foreground ml-auto">{fmtMins(totalMins)}</span>
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border/50">
          {tasks.map(task => (
            <TaskRow key={task.id} task={task} showMode />
          ))}
        </div>
      )}
    </div>
  );
}
