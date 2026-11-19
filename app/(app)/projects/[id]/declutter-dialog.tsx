'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DeclutterList, type DeclutterResult } from '@/components/declutter-list';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import { usePhone } from '@/components/mobile/use-phone';
import type { DeclutterItem } from '@/lib/declutter-core';
import { applyDeclutterAction, declutterProposalAction } from './declutter-actions';

type Loaded = { items: DeclutterItem[]; fyi: string[] };

/**
 * Project › ⋯ › Declutter: the changes Work OS proposes for this project (stale and repeated State lines, repeated pages, finished
 * tasks, old Needs, open Claude items), each ticked; one button applies the ticked ones. Nothing is deleted.
 */
export function DeclutterDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const phone = usePhone();
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | { error: string } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<DeclutterResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    declutterProposalAction(projectId).then(r => {
      if (!live) return;
      if (!r.ok) return void setLoaded({ error: r.error });
      setLoaded({ items: r.items, fyi: r.fyi });
      setTicked(new Set(r.items.map(i => i.id)));
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const toggle = (id: string) => setTicked(t => (t.has(id) ? new Set([...t].filter(x => x !== id)) : new Set([...t, id])));
  const apply = () =>
    start(async () => {
      const r = await applyDeclutterAction(projectId, [...ticked]);
      if (!r.ok) return void toast.error(r.error);
      setResult({ applied: [...ticked].filter(id => !r.failed.some(f => f.startsWith(`${id}: `))), failed: r.failed });
      toast.success(`${r.applied} change${r.applied === 1 ? '' : 's'} applied`);
      router.refresh();
    });

  const items = loaded && 'items' in loaded ? loaded.items : [];
  return (
    <ResponsiveSheet title="Declutter" onClose={onClose} wide>
      <div className="space-y-3 pb-2" data-declutter-dialog>
        {!loaded && <p className="text-sm text-muted-foreground">Looking…</p>}
        {loaded && 'error' in loaded && <p className="text-sm text-destructive" data-declutter-error>{loaded.error}</p>}
        {loaded && 'items' in loaded && !items.length && <p className="text-sm text-muted-foreground" data-declutter-empty>Nothing to tidy.</p>}
        {items.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">Tick what goes. Nothing is deleted: lines, pages and old Claude items are archived and can be put back.</p>
            <DeclutterList items={items} ticked={result ? undefined : ticked} onToggle={result ? undefined : toggle} result={result ?? undefined} phone={phone} testid="dialog" />
          </>
        )}
        {loaded && 'fyi' in loaded && loaded.fyi.map(f => (
          <p key={f} className="text-xs text-muted-foreground">{f}</p>
        ))}
        {items.length > 0 && (
          <div className="flex justify-end pt-1">
            {result ? (
              <button type="button" onClick={onClose} className="h-11 md:h-9 px-4 rounded-full md:rounded-md border border-border text-sm font-medium">
                Close
              </button>
            ) : (
              <button type="button" disabled={pending || !ticked.size} onClick={apply} data-declutter-apply className="h-11 md:h-9 px-4 rounded-full md:rounded-md bg-foreground text-background text-sm font-semibold disabled:opacity-50">
                Apply ticked ({ticked.size})
              </button>
            )}
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
}
