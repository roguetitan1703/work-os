'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { WEEKDAYS, WEEKDAY_LABELS, type Routine, type ScheduleBlock } from '@/lib/schedule';
import { saveScheduleAction } from './actions';
import { Select } from '@/components/ui/select';

const field = 'h-11 md:h-8 rounded-md border border-border bg-background px-2 text-[16px] md:text-sm text-foreground min-w-0';
const emptyModes = () => Object.fromEntries(WEEKDAYS.map(d => [d, ''])) as ScheduleBlock['modes'];
const newBlock = (after?: ScheduleBlock): ScheduleBlock => ({ start: after?.end ?? '09:00', end: after?.end ?? '10:00', block: '', modes: emptyModes(), notes: '' });
const DEFAULT_ROUTINE: Routine = { name: 'Daily routine', start: '09:00', end: '09:30', color: '#FACC15', countLabel: 'Count', question: 'Did you do it today?' };

/**
 * A plain editor for one's own week: a row per block (times, name, what each weekday is for, notes) and the optional
 * routine card. Mode lists offer the organization's modes plus the person's own block names (breaks, routines).
 */
export function ScheduleEditor({ initialBlocks, initialRoutine, modes, extraNames }: { initialBlocks: ScheduleBlock[]; initialRoutine: Routine | null; modes: string[]; extraNames: string[] }) {
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(initialBlocks);
  const [routine, setRoutine] = useState<Routine | null>(initialRoutine);
  const [pending, start] = useTransition();
  const router = useRouter();
  const options = [...new Set([...modes, ...extraNames, ...blocks.flatMap(b => Object.values(b.modes))].filter(Boolean))];

  const set = (i: number, patch: Partial<ScheduleBlock>) => setBlocks(bs => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i: number, d: -1 | 1) =>
    setBlocks(bs => {
      const j = i + d;
      if (j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  function save() {
    start(async () => {
      const r = await saveScheduleAction(blocks, routine);
      if (!r.ok) return void toast.error(r.error);
      toast.success('Schedule saved.');
      router.push('/timetable');
    });
  }

  return (
    <div className="space-y-6" data-schedule-editor>
      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Blocks, Monday to Friday</h2>
        {blocks.length === 0 && <p className="text-sm text-muted-foreground px-1">No blocks. Add your first one.</p>}
        {blocks.map((b, i) => (
          <div key={i} className="rounded-2xl md:rounded-lg border border-border/70 bg-card p-3 space-y-2" data-block-row>
            <div className="flex flex-wrap items-center gap-2">
              <input type="time" aria-label="Start" className={field} value={b.start} onChange={e => set(i, { start: e.target.value })} />
              <span className="text-muted-foreground">–</span>
              <input type="time" aria-label="End" className={field} value={b.end} onChange={e => set(i, { end: e.target.value })} />
              <input aria-label="Block name" placeholder="Block name, e.g. Deep work" className={`${field} flex-1 min-w-[10rem]`} value={b.block} onChange={e => set(i, { block: e.target.value })} />
              <div className="flex items-center gap-1 ml-auto">
                <button type="button" aria-label="Move up" onClick={() => move(i, -1)} className="h-11 w-11 md:h-8 md:w-8 grid place-items-center rounded-md hover:bg-muted"><ArrowUp className="w-4 h-4" /></button>
                <button type="button" aria-label="Move down" onClick={() => move(i, 1)} className="h-11 w-11 md:h-8 md:w-8 grid place-items-center rounded-md hover:bg-muted"><ArrowDown className="w-4 h-4" /></button>
                <button type="button" aria-label="Remove block" onClick={() => setBlocks(bs => bs.filter((_, j) => j !== i))} className="h-11 w-11 md:h-8 md:w-8 grid place-items-center rounded-md text-red-600 hover:bg-muted"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground col-span-2 md:col-span-1">
                Every day
                <Select className={field} value="" onChange={e => e.target.value !== '' && set(i, { modes: Object.fromEntries(WEEKDAYS.map(d => [d, e.target.value === '-' ? '' : e.target.value])) as ScheduleBlock['modes'] })}>
                  <option value="">Set all…</option>
                  <option value="-">(nothing)</option>
                  {options.map(o => <option key={o} value={o}>{o}</option>)}
                </Select>
              </label>
              {WEEKDAYS.map(d => (
                <label key={d} className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {WEEKDAY_LABELS[d]}
                  <Select className={field} value={b.modes[d]} onChange={e => set(i, { modes: { ...b.modes, [d]: e.target.value } })}>
                    <option value="">(nothing)</option>
                    {options.map(o => <option key={o} value={o}>{o}</option>)}
                  </Select>
                </label>
              ))}
            </div>
            <input aria-label="Notes" placeholder="Notes (what this block is for)" className={`${field} w-full`} value={b.notes} onChange={e => set(i, { notes: e.target.value })} />
          </div>
        ))}
        <button type="button" onClick={() => setBlocks(bs => [...bs, newBlock(bs[bs.length - 1])])} className="inline-flex items-center gap-1.5 h-11 md:h-8 px-3 rounded-lg border border-border text-sm" data-add-block>
          <Plus className="w-4 h-4" /> Add block
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Routine card on Today</h2>
        <label className="flex items-center gap-2 px-1 text-sm">
          <input type="checkbox" checked={!!routine} onChange={e => setRoutine(e.target.checked ? (initialRoutine ?? DEFAULT_ROUTINE) : null)} className="h-5 w-5" data-routine-toggle />
          Show a daily routine I log with a number
        </label>
        {routine && (
          <div className="rounded-2xl md:rounded-lg border border-border/70 bg-card p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Name<input className={field} value={routine.name} onChange={e => setRoutine({ ...routine, name: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">From<input type="time" className={field} value={routine.start} onChange={e => setRoutine({ ...routine, start: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">To<input type="time" className={field} value={routine.end} onChange={e => setRoutine({ ...routine, end: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Number label<input className={field} value={routine.countLabel} onChange={e => setRoutine({ ...routine, countLabel: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Colour<input type="color" className={`${field} p-1`} value={routine.color} onChange={e => setRoutine({ ...routine, color: e.target.value.toUpperCase() })} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground col-span-2 md:col-span-1">Question<input className={field} value={routine.question} onChange={e => setRoutine({ ...routine, question: e.target.value })} /></label>
          </div>
        )}
      </section>

      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={pending} className="h-12 md:h-9 px-5 rounded-xl bg-foreground text-background font-semibold disabled:opacity-40" data-save-schedule>
          Save
        </button>
        <button type="button" onClick={() => router.push('/timetable')} className="h-12 md:h-9 px-5 rounded-xl border border-border">
          Cancel
        </button>
      </div>
    </div>
  );
}
