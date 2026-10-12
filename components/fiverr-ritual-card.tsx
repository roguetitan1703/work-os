'use client';

import { useState, useTransition } from 'react';
import { FiverrRitualLog } from '@/lib/types';
import { logFiverrRitual } from '@/app/actions';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Flame, Pencil } from 'lucide-react';

type Props = {
  todayLog: FiverrRitualLog | null;
};

export function FiverrRitualCard({ todayLog }: Props) {
  const [editing, setEditing] = useState(false);
  const [bids, setBids] = useState(todayLog?.bidsPlaced ?? 0);
  const [notes, setNotes] = useState(todayLog?.notes ?? '');
  const [, startTransition] = useTransition();

  const done = !!todayLog && !editing;
  const FIVERR_COLOR = '#FACC15'; // yellow from RITUAL_BLOCKS

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      await logFiverrRitual({ bidsPlaced: bids, notes });
      setEditing(false);
      toast.success('Fiverr ritual logged.');
    });
  }

  function startEdit() {
    setBids(todayLog?.bidsPlaced ?? 0);
    setNotes(todayLog?.notes ?? '');
    setEditing(true);
  }

  return (
    <div
      className="rounded-xl border-2 p-4 transition-all"
      style={{ borderColor: FIVERR_COLOR + (done ? '60' : 'ff'), backgroundColor: FIVERR_COLOR + '10' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 shrink-0" style={{ color: FIVERR_COLOR }} />
          <span className="font-bold text-sm" style={{ color: FIVERR_COLOR }}>
            Fiverr Ritual
          </span>
          <span className="text-xs text-muted-foreground font-mono">11:50–12:35</span>
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
              Done — {todayLog.bidsPlaced} bid{todayLog.bidsPlaced !== 1 ? 's' : ''} placed
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
              {todayLog ? 'Update today\'s Fiverr ritual' : 'Did you do the Fiverr ritual today?'}
            </span>
          </div>
          <div className="flex items-center gap-3 ml-8">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Bids placed</label>
              <input
                type="number"
                min={0}
                max={50}
                value={bids}
                onChange={e => setBids(Number(e.target.value))}
                className="w-20 h-7 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1"
                style={{ focusRingColor: FIVERR_COLOR } as React.CSSProperties}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-muted-foreground">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. applied to 3 web dev gigs"
                className="h-7 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 ml-8">
            <button
              type="submit"
              className="px-3 py-1 text-xs font-semibold rounded-lg transition-colors"
              style={{ backgroundColor: FIVERR_COLOR, color: '#1a1a1a' }}
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
