'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { DispatcherSettings, NotePick } from '@/lib/data/dispatcher';
import { Select } from '@/components/ui/select';
import { Switch } from '../settings/device-settings';
import { autoEnableDispatcherAction, dispatcherSettingsAction } from './dispatcher-actions';
import { write } from './auto-refresh';
import { field } from './ui';

// Claude › Set up: the switch ("Claude starts tasks I give it"), how many tasks at once, and the standing-instructions note
// every session reads first (docs/dispatcher.md). One state for the page: the switch in step 3 and the note in Advanced
// read and write the same settings. Every write is the same server action as before (dispatcherSettingsAction): it acts
// on the signed-in person's own setting only and keeps the rule that turning it on needs one of their own notes.

type Ctx = { s: DispatcherSettings; busy: boolean; save: (patch: Partial<DispatcherSettings>) => Promise<boolean>; adopt: (s: DispatcherSettings) => void; notes: NotePick[]; maxCap: number };
const C = createContext<Ctx | null>(null);
const useD = () => {
  const c = useContext(C);
  if (!c) throw new Error('DispatcherProvider missing');
  return c;
};

export function DispatcherProvider({ initial, notes, maxCap, children }: { initial: DispatcherSettings; notes: NotePick[]; maxCap: number; children: React.ReactNode }) {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<DispatcherSettings>) => {
    setBusy(true);
    const prev = s;
    setS({ ...s, ...patch });
    try {
      const r = await write(() => dispatcherSettingsAction(patch));
      if (!r.ok) {
        setS(prev);
        toast.error(r.error);
        return false;
      }
      setS(r.data);
      return true;
    } catch {
      setS(prev);
      toast.error('Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return <C.Provider value={{ s, busy, save, adopt: setS, notes, maxCap }}>{children}</C.Provider>;
}

/**
 * The offer: when this page opens with a computer that has checked in, or when one checks in while it is open (not when a
 * note is picked later: that person is setting things up by hand), the server switches the person's own switch on, once
 * (autoEnableDispatcher claims it with one conditional write, so a second open page or a reload after Undo cannot do it
 * again), and this tells them, with Undo.
 */
function AutoOn({ ready }: { ready: boolean }) {
  const { s, save, adopt } = useD();
  const hasNote = !!s.boilerplateNoteId;
  useEffect(() => {
    if (!ready || s.enabled || !hasNote) return;
    let alive = true;
    autoEnableDispatcherAction().then(r => {
      if (!alive || !r.ok || !r.data.applied) return;
      adopt(r.data.settings);
      toast('Claude will start the tasks you give it. We switched this on because your PC connected.', {
        action: { label: 'Undo', onClick: () => void save({ enabled: false }) },
        duration: 12000,
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- offered when the page opens or a PC checks in, not on every change
  }, [ready]);
  return null;
}

/**
 * Step 3's body. `ready`: a computer has checked in. The first time that is true (and the person never set the switch and
 * has their note), the server switches it on once and this tells them, with Undo.
 */
export function DispatcherStep({ ready }: { ready: boolean }) {
  const { s, busy, save, maxCap } = useD();
  const hasNote = !!s.boilerplateNoteId;

  return (
    <div className="space-y-4" data-dispatcher-setup>
      <AutoOn ready={ready} />
      <div className="flex items-center gap-3 min-h-11">
        <Switch label="Claude starts tasks I give it" on={s.enabled} disabled={busy || !hasNote} onChange={v => void save({ enabled: v })} />
        <span className="text-[15px] font-medium text-foreground">Claude starts tasks I give it</span>
      </div>
      {!hasNote && (
        <p className="text-[13px] text-muted-foreground" data-needs-note>
          To switch this on, first pick your standing instructions, a note of yours that Claude reads before every task.{' '}
          <button type="button" className="underline underline-offset-2 text-foreground min-h-11 md:min-h-0" onClick={() => window.dispatchEvent(new Event('wos:open-advanced'))}>
            Choose it
          </button>
        </p>
      )}
      <p className="text-[13px] text-muted-foreground">Switch off to pause. Work already running carries on.</p>
      <div className="flex flex-wrap items-center gap-3" data-dispatcher-cap data-cap={s.maxConcurrent}>
        <span className="text-[15px] text-foreground">Claude works on up to</span>
        <div className="inline-flex items-center rounded-lg border border-border bg-card">
          <button type="button" aria-label="One fewer task at a time" disabled={busy || s.maxConcurrent <= 1} onClick={() => void save({ maxConcurrent: s.maxConcurrent - 1 })} className="w-11 h-11 md:w-9 md:h-9 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40">
            <Minus size={16} aria-hidden />
          </button>
          <span className="w-8 text-center text-[15px] font-medium tabular-nums" aria-live="polite" data-cap-value>
            {s.maxConcurrent}
          </span>
          <button type="button" aria-label="One more task at a time" disabled={busy || s.maxConcurrent >= maxCap} onClick={() => void save({ maxConcurrent: s.maxConcurrent + 1 })} className="w-11 h-11 md:w-9 md:h-9 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40">
            <Plus size={16} aria-hidden />
          </button>
        </div>
        <span className="text-[15px] text-foreground">tasks at a time</span>
      </div>
    </div>
  );
}

/** Standing instructions (Advanced): the note every session reads first. Needed before the switch can go on. */
export function StandingNote() {
  const { s, busy, save, notes } = useD();
  const known = notes.some(n => n.id === s.boilerplateNoteId);
  return (
    <label className="block space-y-1" data-standing-note>
      <span className="block text-sm font-medium text-foreground">Standing instructions</span>
      <Select className={field} value={s.boilerplateNoteId} disabled={busy} onChange={e => void save({ boilerplateNoteId: e.target.value })} aria-label="Standing instructions note" data-dispatcher-note>
        <option value="">Pick a note…</option>
        {!known && s.boilerplateNoteId && <option value={s.boilerplateNoteId}>(note not in the list)</option>}
        {notes.map(n => (
          <option key={n.id} value={n.id}>
            {n.title}
            {n.project ? ` · ${n.project}` : ''}
          </option>
        ))}
      </Select>
      <span className="block text-[13px] text-muted-foreground">A note of yours that Claude reads before every task, for example how you like code written. Claude can read it; only you can edit it. It has to be your own note, and the switch in step 3 needs one.</span>
    </label>
  );
}
