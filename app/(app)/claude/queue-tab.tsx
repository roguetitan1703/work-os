'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronsUp } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { QueueGroup } from '@/lib/data/claude-overview';
import type { ClaudeItem } from '@/lib/types';
import { Chip, ItemSheet } from '../projects/[id]/claude-items';
import { moveClaudeItemAction, updateClaudeItemAction } from '../projects/[id]/claude-items-actions';
import { write } from './auto-refresh';
import { card, H2 } from './ui';

const ctl = 'h-11 md:h-8 min-w-11 md:min-w-8 px-3 md:px-2 rounded-full md:rounded-md inline-flex items-center justify-center gap-1 text-[13px] font-medium border border-border text-foreground active:bg-muted hover:bg-muted/50 disabled:opacity-40 shrink-0';

export function QueueTab({ groups }: { groups: QueueGroup[] }) {
  const [sel, setSel] = useState<{ projectId: string; ref: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(id);
    try {
      const r = await write(fn);
      // No router.refresh() here: the action revalidates, so its response already carries the new page (see write()).
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  if (groups.length === 0) return <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">The queue is empty. Items Claude Code adds to a project&apos;s work list show up here.</p>;
  const open = sel ? groups.find(g => g.projectId === sel.projectId) : undefined;

  return (
    <div className="space-y-5 md:max-w-3xl" data-section="queue">
      {groups.map(g => (
        <section key={g.projectId} className="space-y-2" data-queue-project={g.projectId}>
          <h2 className={cn(H2, 'px-1 md:px-0 text-muted-foreground flex items-center gap-2')}>
            <Link href={`/projects/${encodeURIComponent(g.projectId)}`} className="hover:text-foreground">
              {g.projectName}
            </Link>
            <span className="font-normal normal-case tracking-normal">{g.items.length} open</span>
          </h2>
          <ul className={cn(card, 'divide-y divide-border/60')}>
            {g.items.map((i, n) => (
              <Row
                key={i.id}
                item={i}
                blocker={i.blockedBy ? g.blockers[i.blockedBy] : undefined}
                first={n === 0}
                last={n === g.items.length - 1}
                busy={busy === i.id}
                onOpen={() => setSel({ projectId: g.projectId, ref: i.ref })}
                onNext={() => run(i.id, () => updateClaudeItemAction(g.projectId, i.id, { next: !i.next }))}
                onMove={dir => run(i.id, () => moveClaudeItemAction(g.projectId, i.id, dir, 1))}
              />
            ))}
          </ul>
        </section>
      ))}
      {sel && open && <ItemSheet projectId={open.projectId} items={open.items} blockers={open.blockers} sel={sel.ref} onClose={() => setSel(null)} />}
    </div>
  );
}

function Row({ item: i, blocker, first, last, busy, onOpen, onNext, onMove }: { item: ClaudeItem; blocker?: { ref: number; title: string }; first: boolean; last: boolean; busy: boolean; onOpen: () => void; onNext: () => void; onMove: (d: 'up' | 'down' | 'top') => void }) {
  const canNext = i.kind !== 'idea' && i.state === 'queued';
  return (
    <li data-queue-item={`C${i.ref}`}>
      <button type="button" onClick={onOpen} className="w-full text-left flex items-start gap-2 px-4 md:px-3 pt-3 md:pt-2 pb-1 min-h-11 hover:bg-muted/50 active:bg-muted/60">
        <span className="font-mono text-xs text-muted-foreground shrink-0 pt-1 w-9">C{i.ref}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip kind={i.kind} />
            <span className="text-[16px] md:text-sm font-medium">{i.title}</span>
            {i.next && i.state === 'queued' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-300 font-medium">next</span>}
          </div>
          <div className="text-[13px] md:text-xs text-muted-foreground">
            {i.state}
            {i.state === 'active' && i.claimedBy ? ` · in ${i.claimedBy.session}` : ''}
            {i.state === 'blocked' && blocker && !i.waitingOn ? ` · waits on C${blocker.ref} ${blocker.title}` : ''}
          </div>
          {i.waitingOn && <div className="text-[13px] md:text-xs text-amber-700 dark:text-amber-300 line-clamp-2">{i.waitingText}</div>}
        </div>
      </button>
      <div className="flex items-center gap-2 px-4 md:px-3 pb-2 pl-[3.75rem] md:pl-[3.5rem]">
        {canNext && (
          <button type="button" aria-pressed={i.next} disabled={busy} onClick={onNext} className={cn(ctl, i.next && 'bg-green-500/15 border-green-500/40 text-green-700 dark:text-green-300')} aria-label={`Next C${i.ref}`}>
            Next
          </button>
        )}
        <button type="button" disabled={busy || first} onClick={() => onMove('top')} className={ctl} aria-label={`Move C${i.ref} to top`}>
          <ChevronsUp className="w-4 h-4" /> Top
        </button>
        <button type="button" disabled={busy || first} onClick={() => onMove('up')} className={ctl} aria-label={`Move C${i.ref} up`}>
          <ArrowUp className="w-4 h-4" />
        </button>
        <button type="button" disabled={busy || last} onClick={() => onMove('down')} className={ctl} aria-label={`Move C${i.ref} down`}>
          <ArrowDown className="w-4 h-4" />
        </button>
      </div>
    </li>
  );
}
