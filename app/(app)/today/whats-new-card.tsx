'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/intent-link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { WhatsNewEntry } from '@/lib/whats-new';
import { markWhatsNewSeenAction } from '../whats-new/actions';

export type WhatsNewCardData = { entries: WhatsNewEntry[]; more: number };

const btn = 'h-11 md:h-9 px-4 rounded-lg text-sm font-medium shrink-0 inline-flex items-center justify-center whitespace-nowrap border border-border bg-card text-foreground hover:bg-muted/60 active:bg-muted disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/**
 * "New in Work OS" on Today: up to three entries from lib/whats-new.ts the person has not seen, shipped in the last
 * NEW_DAYS (14) days, each with Try it; "N more" goes to /whats-new. Try it marks that one seen, Dismiss marks them all. Hidden when none.
 * Looks like Today's other side cards (Now & next on the desktop, the Claude card on the phone).
 */
export function WhatsNewCard({ data, phone }: { data: WhatsNewCardData | null; phone: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  if (!data?.entries.length || gone) return null;

  const dismiss = () =>
    start(async () => {
      const r = await markWhatsNewSeenAction();
      if (!r.ok) return void toast.error(r.error);
      setGone(true);
    });
  const tryIt = (e: WhatsNewEntry) =>
    start(async () => {
      await markWhatsNewSeenAction(e.id).catch(() => null);
      router.push(e.href);
    });

  return (
    <section data-section="whats-new" aria-label="New in Work OS" className={cn('border bg-card overflow-hidden', phone ? 'mt-4 rounded-2xl border-border/70' : 'rounded-lg border-border')}>
      <div className={cn('flex items-center justify-between border-b border-border/60', phone ? 'px-4 min-h-11' : 'px-3 min-h-10')}>
        <h2 className={cn('font-semibold uppercase tracking-wider text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>
          New in Work OS
          <span className="ml-1.5 font-normal">{data.entries.length + data.more}</span>
        </h2>
        <Link href="/whats-new" className={cn('text-muted-foreground hover:text-foreground', phone ? 'inline-flex items-center min-h-11 text-[13px]' : 'text-xs')}>
          See all ›
        </Link>
      </div>
      <ul className="divide-y divide-border/60">
        {data.entries.map(e => (
          <li key={e.id} data-whats-new={e.id} className={cn('flex items-center gap-3', phone ? 'pl-4 pr-3 py-2.5 min-h-14' : 'px-3 py-2')}>
            <div className="flex-1 min-w-0">
              <div className={cn('font-medium text-foreground', phone ? 'text-[15px]' : 'text-sm')}>{e.title}</div>
              <div className={cn('text-muted-foreground leading-snug', phone ? 'text-[13px]' : 'text-xs')}>{e.line}</div>
            </div>
            <a
              href={e.href}
              data-whats-new-try={e.id}
              aria-label={`Try it: ${e.title}`}
              aria-disabled={pending}
              className={btn}
              onClick={ev => {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                ev.preventDefault();
                if (!pending) tryIt(e);
              }}
            >
              Try it
            </a>
          </li>
        ))}
      </ul>
      <div className={cn('flex items-center justify-between gap-2 border-t border-border/60', phone ? 'pl-4 pr-2 min-h-11' : 'pl-3 pr-1 min-h-10')}>
        {data.more > 0 ? (
          <Link href="/whats-new" data-whats-new-more className={cn('font-medium text-foreground', phone ? 'inline-flex items-center min-h-11 text-[13px]' : 'text-xs')}>
            and {data.more} more ›
          </Link>
        ) : (
          <span />
        )}
        <button type="button" data-whats-new-dismiss disabled={pending} onClick={dismiss} className="h-11 md:h-9 px-3 rounded-lg text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50">
          Dismiss
        </button>
      </div>
    </section>
  );
}
