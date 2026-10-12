'use client';

import { useMemo, useTransition } from 'react';
import { Task, Status } from '@/lib/types';
import { buildDayPlan, SlotAssignment } from '@/lib/day-plan';
import { getBlockColor } from '@/lib/modes';
import { completeTaskAction } from '@/app/actions';
import { PriorityBadge } from '@/components/priority-badge';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CheckCircle2, Clock, AlertTriangle, Inbox } from 'lucide-react';
import { format, parseISO } from 'date-fns';

type Props = {
  open: boolean;
  onClose: () => void;
  allTasks: Task[];
  weekday: 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
};

const STATUS_DOT: Record<Status, string> = {
  'Not Started': 'bg-muted-foreground/40',
  'In Progress': 'bg-blue-500',
  'Blocked': 'bg-red-500',
  'Done': 'bg-green-500',
  'Dropped': 'bg-muted-foreground/20',
};

function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function fmtDate(d?: string | null) {
  if (!d) return null;
  try { return format(parseISO(d), 'MMM d'); } catch { return null; }
}

export function DayPlanDialog({ open, onClose, allTasks, weekday }: Props) {
  const plan = useMemo(() => buildDayPlan(allTasks, weekday), [allTasks, weekday]);
  const [, startTransition] = useTransition();

  function markDone(id: string) {
    startTransition(async () => {
      const res = await completeTaskAction(id);
      if (res.ok) toast.success('Marked done.');
      else toast.error(res.error);
    });
  }

  const activeSlots = plan.slots.filter(s => s.tasks.length > 0);
  const totalActive = allTasks.filter(t => t.status !== 'Done' && t.status !== 'Dropped').length;
  const totalEstimate = allTasks
    .filter(t => t.status !== 'Done' && t.status !== 'Dropped')
    .reduce((s, t) => s + (t.estimateMins ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background border-b px-6 py-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Day Plan</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Inbox className="w-3.5 h-3.5" />
              {totalActive} tasks
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {fmtMins(totalEstimate)} estimated
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {fmtMins(plan.totalSlotMins)} in schedule
            </span>
            {totalEstimate > plan.totalSlotMins && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <AlertTriangle className="w-3.5 h-3.5" />
                {fmtMins(totalEstimate - plan.totalSlotMins)} overflow
              </span>
            )}
          </div>
        </div>

        <div className="px-6 py-4 space-y-1">
          {activeSlots.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">
              No tasks scheduled. Add tasks with modes that match your schedule blocks.
            </div>
          ) : (
            activeSlots.map((slot, si) => (
              <SlotSection key={si} slot={slot} onMarkDone={markDone} />
            ))
          )}

          {plan.unscheduled.length > 0 && (
            <div className="mt-6 pt-4 border-t">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                Unscheduled ({plan.unscheduled.length})
              </div>
              <div className="space-y-1">
                {plan.unscheduled.map(({ task, reason }) => (
                  <div key={task.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 group">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[task.status]}`} />
                    <span className="text-sm text-foreground flex-1 truncate">{task.title}</span>
                    <PriorityBadge priority={task.priority} />
                    <span className="text-xs text-muted-foreground truncate max-w-[160px]">{reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SlotSection({ slot, onMarkDone }: { slot: SlotAssignment; onMarkDone: (id: string) => void }) {
  const color = getBlockColor(slot.modeName);
  const fillPct = Math.min(100, Math.round((slot.usedMins / slot.slotMins) * 100));
  const isOver = slot.overflowMins > 0;

  return (
    <div className="mb-5">
      {/* Slot header */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">
          {slot.block.start}–{slot.block.end}
        </span>
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold shrink-0"
          style={{ backgroundColor: color.hex + '20', color: color.hex }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color.hex }} />
          {slot.modeName}
          {slot.taskMode && slot.taskMode !== slot.modeName && (
            <span className="opacity-60 font-normal"> → {slot.taskMode}</span>
          )}
        </span>
        <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${fillPct}%`, backgroundColor: isOver ? '#f59e0b' : color.hex }}
          />
        </div>
        <span className={`text-xs shrink-0 tabular-nums ${isOver ? 'text-amber-500' : 'text-muted-foreground'}`}>
          {fmtMins(slot.usedMins)}/{fmtMins(slot.slotMins)}
          {isOver && ` +${fmtMins(slot.overflowMins)}`}
        </span>
      </div>

      {/* Tasks in this slot */}
      <div className="ml-24 space-y-0.5">
        {slot.tasks.map(({ task, startOffset, endsOffset }, ti) => {
          const isDone = task.status === 'Done';
          const isBlocked = task.status === 'Blocked';
          const isInProgress = task.status === 'In Progress';
          const fitsInSlot = endsOffset <= slot.slotMins;
          const due = fmtDate(task.due);

          return (
            <div
              key={task.id}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                isDone ? 'opacity-40' : 'hover:bg-muted/60'
              }`}
            >
              {/* Status dot */}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[task.status]}`} />

              {/* Seq number */}
              <span className="text-xs text-muted-foreground/50 w-4 shrink-0 tabular-nums">{ti + 1}.</span>

              {/* Task name */}
              <span className={`text-sm flex-1 min-w-0 truncate ${isDone ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                {task.title}
              </span>

              {/* Metadata chips */}
              <div className="flex items-center gap-1.5 shrink-0">
                <PriorityBadge priority={task.priority} />
                <span className={`text-xs tabular-nums font-mono ${!fitsInSlot ? 'text-amber-500' : 'text-muted-foreground'}`}>
                  {fmtMins(task.estimateMins ?? 30)}
                </span>
                {due && (
                  <span className="text-xs text-muted-foreground">{due}</span>
                )}
                {isBlocked && (
                  <span className="text-xs text-red-500 font-medium">blocked</span>
                )}
                {isInProgress && (
                  <span className="text-xs text-blue-500 font-medium">in progress</span>
                )}
              </div>

              {/* Mark done */}
              {!isDone && (
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 text-muted-foreground hover:text-green-500"
                  onClick={() => onMarkDone(task.id)}
                  title="Mark done"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}

        {/* Free time indicator */}
        {slot.freeMins > 0 && (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground/50 italic">
            <span className="w-1.5 h-1.5 rounded-full bg-muted shrink-0" />
            <span>{fmtMins(slot.freeMins)} free</span>
          </div>
        )}
      </div>
    </div>
  );
}
