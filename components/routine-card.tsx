'use client';

import { useState, useTransition } from 'react';
import type { RoutineLog } from '@/lib/types';
import type { Routine } from '@/lib/schedule';
import { logRoutine } from '@/app/actions';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Flame, Pencil } from 'lucide-react';

type Props = {
  /** The person's routine (their schedule's `routine`). */
  routine: Routine;
  todayLog: RoutineLog | null;
};

/** Today's routine: log a count (and a note) once a day, edit it later. */
export function RoutineCard({ routine, todayLog }: Props) {
  const [editing, setEditing] = useState(false);
  const [count, setCount] = useState(todayLog?.count ?? 0);
  const [notes, setNotes] = useState(todayLog?.notes ?? '');
  const [, startTransition] = useTransition();

  const done = !!todayLog && !editing;
  const color = routine.color;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      await logRoutine({ count, notes });
      setEditing(false);
      toast.success(`${routine.name} logged.`);
    });
  }

  function startEdit() {
    setCount(todayLog?.count ?? 0);
    setNotes(todayLog?.notes ?? '');
    setEditing(true);
  }

  return (
    <div
      className="rounded-xl border-2 p-4 transition-all"
      style={{ borderColor: color + (done ? '60' : 'ff'), backgroundColor: color + '10' }}
      data-routine
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 shrink-0" style={{ color }} />
          <span className="font-bold text-sm" style={{ color }}>
            {routine.name}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {routine.start}–{routine.end}
          </span>
        </div>
        {done ? (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
        ) : null}
      </div>

      {done ? (
        /* Logged state */
        <div className="flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 shrink-0 text-green-500" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-foreground">
              Done: {routine.countLabel} {todayLog.count}
            </span>
            {todayLog.notes && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{todayLog.notes}</p>
            )}
          </div>
        </div>
      ) : editing || !todayLog ? (
        /* Log form */
        <form onSubmit={submit} className="space-y-3">
          <div className="flex items-center gap-3">
            <Circle className="w-5 h-5 shrink-0 text-muted-foreground/40" />
            <span className="text-sm text-muted-foreground">
              {todayLog ? `Update today's ${routine.name}` : routine.question}
            </span>
          </div>
          <div className="flex items-center gap-3 ml-8">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{routine.countLabel}</label>
              <input
                type="number"
                min={0}
                max={10000}
                value={count}
                onChange={e => setCount(Number(e.target.value))}
                className="w-20 h-7 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1"
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-muted-foreground">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={routine.placeholder ?? ''}
                className="h-7 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 ml-8">
            <button
              type="submit"
              className="px-3 py-1 text-xs font-semibold rounded-lg transition-colors"
              style={{ backgroundColor: color, color: '#1a1a1a' }}
            >
              {todayLog ? 'Update' : 'Mark done'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="px-3 py-1 text-xs rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : null}
    </div>
  );
}
