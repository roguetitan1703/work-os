'use client';

import { useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Check } from 'lucide-react';
import { completeTaskAction } from '@/app/actions';
import { buildDayPlan } from '@/lib/day-plan';
import { useApp, useModes } from '@/components/app-context';
import { fmtMins } from '@/lib/format';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { BottomSheet } from './sheet';

/** Phone Day Plan: same plan as desktop (buildDayPlan), laid out as a scrollable bottom sheet. */
export function MobileDayPlan({ open, onClose, allTasks, weekday }: { open: boolean; onClose: () => void; allTasks: Task[]; weekday: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' }) {
  const { plan: week } = useApp();
  const { color: colorOf } = useModes();
  const plan = useMemo(() => buildDayPlan(allTasks, weekday, week), [allTasks, weekday, week]);
  const router = useRouter();
  const [, start] = useTransition();
  if (!open) return null;

  const openTasks = allTasks.filter(t => t.status !== 'Done' && t.status !== 'Dropped');
  const totalEstimate = openTasks.reduce((s, t) => s + (t.estimateMins ?? 0), 0);
  const slots = plan.slots.filter(s => s.tasks.length > 0);

  function done(id: string) {
    navigator.vibrate?.(10);
    start(async () => {
      const res = await completeTaskAction(id);
      if (!res.ok) return void toast.error(res.error);
      toast.success('Marked done.');
      router.refresh();
    });
  }

  return (
    <BottomSheet title="Day plan" onClose={onClose}>
      <div className="text-[13px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{openTasks.length} tasks</span>
        <span>{fmtMins(totalEstimate)} estimated</span>
        <span>{fmtMins(plan.totalSlotMins)} in schedule</span>
        {totalEstimate > plan.totalSlotMins && (
          <span className="text-amber-600 dark:text-amber-400 font-medium inline-flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {fmtMins(totalEstimate - plan.totalSlotMins)} overflow
          </span>
        )}
      </div>

      {slots.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No tasks scheduled. Add tasks with modes that match your schedule blocks.</p>
      ) : (
        slots.map((slot, si) => {
          const color = colorOf(slot.modeName);
          const pct = Math.min(100, Math.round((slot.usedMins / slot.slotMins) * 100));
          return (
            <section key={si} className="mt-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
                  {slot.block.start}–{slot.block.end}
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold truncate" style={{ backgroundColor: color.hex + '20', color: color.hex }}>
                  {slot.modeName}
                  {slot.taskMode && slot.taskMode !== slot.modeName && <span className="opacity-60 font-normal"> → {slot.taskMode}</span>}
                </span>
                <span className={cn('ml-auto text-[12px] tabular-nums shrink-0', slot.overflowMins > 0 ? 'text-amber-500' : 'text-muted-foreground')}>
                  {fmtMins(slot.usedMins)}/{fmtMins(slot.slotMins)}
                </span>
              </div>
              <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: slot.overflowMins > 0 ? '#f59e0b' : color.hex }} />
              </div>
              <div className="mt-1 rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
                {slot.tasks.map(({ task }) => {
                  const closed = task.status === 'Done';
                  return (
                    <div key={task.id} className={cn('flex items-center min-h-12', closed && 'opacity-40')}>
                      <div className="flex-1 min-w-0 pl-3 py-2">
                        <div className={cn('text-[15px] leading-snug', closed && 'line-through text-muted-foreground')}>{task.title}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {task.priority} · {fmtMins(task.estimateMins ?? 30)}
                          {task.status === 'Blocked' && <span className="text-red-500"> · blocked</span>}
                          {task.status === 'In Progress' && <span className="text-blue-500"> · in progress</span>}
                        </div>
                      </div>
                      {!closed && (
                        <button onClick={() => done(task.id)} aria-label={`Complete ${task.title}`} className="w-12 h-12 shrink-0 flex items-center justify-center text-muted-foreground active:text-green-500">
                          <Check className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {slot.freeMins > 0 && <div className="px-3 py-2 text-[12px] italic text-muted-foreground/70">{fmtMins(slot.freeMins)} free</div>}
              </div>
            </section>
          );
        })
      )}

      {plan.unscheduled.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Unscheduled ({plan.unscheduled.length})
          </h3>
          <div className="rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
            {plan.unscheduled.map(({ task, reason }) => (
              <div key={task.id} className="px-3 py-2.5 min-h-12">
                <div className="text-[15px] leading-snug">{task.title}</div>
                <div className="text-[12px] text-muted-foreground">
                  {task.priority} · {reason}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </BottomSheet>
  );
}
