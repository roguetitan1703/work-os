import Link from '@/components/intent-link';
import { ChevronRight, Megaphone } from 'lucide-react';
import { format } from 'date-fns';
import { MGroupTitle } from '@/components/mobile/sub-header';
import { ScreenHeader } from '@/components/mobile/tab-bar';
import { NewBadge } from '@/components/new-badge';
import { requireCaller } from '@/lib/caller';
import { whatsNewState } from '@/lib/whats-new-seen';
import { byDate, isRecent } from '@/lib/whats-new';
import { MarkSeen } from './mark-seen';

export const metadata = { title: "What's new · Work OS" };

/** Everything lib/whats-new.ts lists, newest first: one line each and where to find it. Opening it clears the nav dot. */
export default async function WhatsNewPage() {
  const me = await requireCaller();
  const { today, entries, unseen } = await whatsNewState(me);
  const days = byDate(entries, today);
  return (
    <div className="max-w-xl mx-auto" data-view="whats-new">
      <ScreenHeader title="What's new" sub="New in Work OS, newest first." back="/menu" backLabel="Menu" className="mb-4" />
      {unseen.length > 0 && <MarkSeen />}
      {days.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center text-muted-foreground">
          <Megaphone className="w-10 h-10 mb-3" />
          <div className="text-lg font-semibold text-foreground">Nothing new yet</div>
          <div className="text-sm max-w-xs">New features show up here when they ship, with where to find them.</div>
        </div>
      ) : (
        days.map(d => (
          <section key={d.date} className="mt-5 first:mt-2 md:first:mt-0" data-whats-new-day={d.date}>
            <MGroupTitle>{format(new Date(d.date + 'T12:00:00Z'), 'MMMM d, yyyy')}</MGroupTitle>
            <ul className="rounded-2xl md:rounded-lg bg-card border border-border/70 md:border-border divide-y divide-border/60 overflow-hidden">
              {d.entries.map(e => (
                <li key={e.id} data-whats-new-entry={e.id}>
                  <Link href={e.href} className="flex items-start gap-3 px-4 md:px-3 py-3 md:py-2.5 active:bg-muted/60 md:hover:bg-muted/40">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[15px] md:text-sm font-medium text-foreground">
                        <span className="min-w-0">{e.title}</span>
                        <NewBadge on={isRecent(e, today)} />
                      </div>
                      <div className="text-[13px] md:text-xs text-muted-foreground leading-snug">{e.line}</div>
                      <div className="text-[12px] md:text-xs text-muted-foreground mt-0.5" data-whats-new-where>
                        Where: <span className="text-foreground/80">{e.where}</span>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 mt-1 shrink-0 text-muted-foreground/40" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
