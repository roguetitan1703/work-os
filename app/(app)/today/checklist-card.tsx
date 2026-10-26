'use client';

import { useState, useTransition } from 'react';
import Link from '@/components/intent-link';
import { Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { Checklist, ChecklistRow } from '@/lib/get-started';
import { hideChecklistAction, showChecklistAction } from './checklist-actions';

const btn = 'h-11 md:h-9 px-4 rounded-lg text-sm font-medium shrink-0 inline-flex items-center justify-center whitespace-nowrap border border-border bg-card text-foreground hover:bg-muted/60 active:bg-muted disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/**
 * The first-run checklist ("Get set up, 2 of 5 done"). Every row ticks from real data (lib/get-started.ts); "Hide this"
 * hides it for this person. On Today it shows until everything is done or hidden; in Settings › Get started it always
 * shows, with a way to bring it back to Today. `welcome` is the one-line greeting after joining.
 */
export function ChecklistCard({ list, where, welcome }: { list: Checklist; where: 'today' | 'settings'; welcome?: string | null }) {
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  // On Today it is open on day one (no task yet) and folded to one line once the person is under way, so it never crowds the day.
  const [open, setOpen] = useState(where === 'settings' || !list.rows.some(r => r.id === 'task' && r.done));
  if (where === 'today' && (list.hidden || list.complete || gone)) return null;

  const undone = list.rows.filter(r => !r.done && !r.optional && !r.group).length;
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Something went wrong');
      onOk?.();
    });

  return (
    <section data-checklist={where} aria-label="Get set up" className="rounded-2xl md:rounded-xl border border-border/70 bg-card overflow-hidden">
      <div className="px-4 pt-2 pb-1">
        {welcome && (
          <p data-welcome className="text-[15px] font-medium text-foreground mb-1">
            {welcome} {undone > 0 ? `${undone === 1 ? 'One thing' : `${undone} things`} to do first.` : 'You are all set.'}
          </p>
        )}
        {where === 'today' ? (
          <button type="button" aria-expanded={open} data-checklist-toggle onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 min-h-11 text-left">
            <h2 className="text-[15px] font-semibold text-foreground">Get set up</h2>
            <span className="flex items-center gap-2">
              <span data-checklist-count className="text-[13px] text-muted-foreground tabular-nums">
                {list.done} of {list.total} done
              </span>
              <ChevronDown size={16} aria-hidden className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
            </span>
          </button>
        ) : (
          <div className="flex items-center justify-between gap-3 min-h-9">
            <h2 className="text-[15px] font-semibold text-foreground">Get set up</h2>
            <span data-checklist-count className="text-[13px] text-muted-foreground tabular-nums">
              {list.done} of {list.total} done
            </span>
          </div>
        )}
      </div>
      {open && (
        <ul className="divide-y divide-border/60 border-t border-border/60 mt-1">
          {list.rows.map(r => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      )}
      <div className={cn('flex items-center justify-end px-2 border-t border-border/60 min-h-11', !open && 'hidden')}>
        {where === 'today' ? (
          <button type="button" data-checklist-hide disabled={pending} className="h-11 md:h-9 px-3 rounded-lg text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50" onClick={() => act(hideChecklistAction, () => setGone(true))}>
            Hide this
          </button>
        ) : list.hidden ? (
          <button type="button" data-checklist-show disabled={pending} className={btn} onClick={() => act(showChecklistAction, () => toast('Back on Today until you finish it'))}>
            Show on Today
          </button>
        ) : (
          <button type="button" data-checklist-hide disabled={pending} className="h-11 md:h-9 px-3 rounded-lg text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50" onClick={() => act(hideChecklistAction, () => toast('Hidden from Today. It stays here.'))}>
            Hide on Today
          </button>
        )}
      </div>
    </section>
  );
}

function Row({ row: r }: { row: ChecklistRow }) {
  return (
    <li data-checklist-row={r.id} data-done={r.done ? '1' : '0'} className="flex items-center gap-3 pl-4 pr-3 py-2 min-h-14">
      <span aria-hidden className={cn('w-5 h-5 shrink-0 rounded-full grid place-items-center border', r.done ? 'bg-foreground border-foreground text-background' : 'border-muted-foreground/40')}>
        {r.done && <Check size={13} strokeWidth={2.4} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className={cn('text-[15px]', r.done ? 'text-muted-foreground line-through' : 'text-foreground')}>
          {r.label}
          {r.optional && !r.done && <span className="ml-2 text-[12px] text-muted-foreground no-underline">Optional</span>}
          <span className="sr-only">{r.done ? ' (done)' : ' (not done)'}</span>
        </div>
        {!r.done && <div className="text-[13px] text-muted-foreground leading-snug">{r.hint}</div>}
      </div>
      {!r.done &&
        (r.action === 'quick-add' ? (
          <button type="button" className={btn} onClick={() => window.dispatchEvent(new Event('wos:quick-add'))}>
            {r.button}
          </button>
        ) : (
          r.href && (
            <Link href={r.href} className={btn}>
              {r.button}
            </Link>
          )
        ))}
    </li>
  );
}
