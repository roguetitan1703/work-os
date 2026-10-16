'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DispatcherSettings, NotePick } from '@/lib/data/dispatcher';
import { cn } from '@/lib/utils';
import { Section } from '../settings/ui';
import { dispatcherSettingsAction } from './dispatcher-actions';
import { field } from './ui';

// Claude › Setup › Tasks for Claude: the dispatcher's on/off switch, how many sessions at once, and the
// note every session reads first (docs/dispatcher.md).

export function DispatcherSetup({ initial, notes, maxCap }: { initial: DispatcherSettings; notes: NotePick[]; maxCap: number }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);

  const save = async (patch: Partial<DispatcherSettings>) => {
    setBusy(true);
    const prev = s;
    setS({ ...s, ...patch });
    try {
      const r = await dispatcherSettingsAction(patch);
      if (!r.ok) {
        setS(prev);
        return void toast.error(r.error);
      }
      setS(r.data);
      router.refresh();
    } catch {
      setS(prev);
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const known = notes.some(n => n.id === s.boilerplateNoteId);
  return (
    <Section title="Tasks for Claude">
      <div className="space-y-4" data-dispatcher-setup>
        <p className="text-sm text-muted-foreground">
          When this is on, tasks you give to Claude start by themselves in a Claude Code session on a computer that has room. Turn it off to pause: nothing new starts, and sessions already working carry on.
        </p>
        <label className="flex items-center gap-3 min-h-11 cursor-pointer">
          <input type="checkbox" className="w-5 h-5" checked={s.enabled} disabled={busy} onChange={e => save({ enabled: e.target.checked })} data-dispatcher-enabled />
          <span className="text-[16px] md:text-sm font-medium">{s.enabled ? 'On' : 'Off'}</span>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Sessions at once</span>
          <select className={cn(field, 'md:max-w-[8rem]')} value={s.maxConcurrent} disabled={busy} onChange={e => save({ maxConcurrent: Number(e.target.value) })} aria-label="Sessions at once" data-dispatcher-cap>
            {Array.from({ length: maxCap }, (_, n) => n + 1).map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Note every session reads first</span>
          <select className={field} value={s.boilerplateNoteId} disabled={busy} onChange={e => save({ boilerplateNoteId: e.target.value })} aria-label="Note every session reads first" data-dispatcher-note>
            <option value="">Pick a note…</option>
            {!known && s.boilerplateNoteId && <option value={s.boilerplateNoteId}>(note not in the list)</option>}
            {notes.map(n => (
              <option key={n.id} value={n.id}>
                {n.title}
                {n.project ? ` · ${n.project}` : ''}
              </option>
            ))}
          </select>
          <span className="block text-[13px] md:text-xs text-muted-foreground">Your Claude Code boilerplate. The session reads it through the Work OS connection, so it always gets the current version. Claude can read this note; only you can edit it.</span>
        </label>
      </div>
    </Section>
  );
}
