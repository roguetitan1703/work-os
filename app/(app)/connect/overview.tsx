import Link from 'next/link';
import { Bell, Bot, ChevronRight, Laptop, MessageSquare, SquareTerminal } from 'lucide-react';
import type { Card as C } from './overview-data';
import { Dot } from './ui';
import { cn } from '@/lib/utils';

const ICON = { chat: MessageSquare, code: SquareTerminal, discord: Bot, alerts: Bell, devices: Laptop } as const;

/** One tappable card per integration: 2x2 on desktop, a stacked list of 64px+ rows on phone. */
export function Overview({ cards }: { cards: C[] }) {
  return (
    <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden md:rounded-none md:bg-transparent md:border-0 md:divide-y-0 md:overflow-visible md:grid md:grid-cols-2 md:gap-3">
      {cards.map(c => {
        const Icon = ICON[c.tab];
        return (
          <Link
            key={c.tab}
            href={c.tab === 'code' ? '/claude?tab=setup' : `/connect?tab=${c.tab}`}
            data-card={c.tab}
            className={cn(
              'flex items-center gap-3 px-4 py-3 min-h-16 min-w-0 active:bg-muted/60',
              'md:flex-col md:items-stretch md:gap-2 md:p-4 md:rounded-2xl md:bg-card md:border md:border-border/70 md:hover:bg-muted/40',
            )}
          >
            <Icon className="w-5 h-5 text-muted-foreground shrink-0 md:hidden" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="w-5 h-5 text-muted-foreground shrink-0 hidden md:block" />
                <span className="text-[16px] md:text-[15px] font-medium text-foreground truncate">{c.title}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0 md:pl-7">
                <Dot level={c.level} />
                <span className="text-[13px] text-foreground/85 truncate" suppressHydrationWarning>
                  {c.status}
                </span>
              </div>
              {c.facts.length > 0 && (
                <div className="text-[12px] text-muted-foreground truncate md:whitespace-normal md:pl-7" suppressHydrationWarning>
                  {c.facts.join(' · ')}
                </div>
              )}
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 md:hidden" />
          </Link>
        );
      })}
    </div>
  );
}
