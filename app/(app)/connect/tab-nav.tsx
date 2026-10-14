'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { TABS, type TabId } from './data';

/** Segmented tab row, scrollable on phone. The active tab lives in `?tab=`. */
export function TabNav({ active }: { active: TabId }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [active]);
  return (
    <nav ref={ref} aria-label="Connect sections" className="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="inline-flex gap-1 rounded-2xl bg-muted/60 p-1 min-w-max">
        {TABS.map(t => (
          <Link
            key={t.id}
            href={t.id === 'overview' ? '/connect' : `/connect?tab=${t.id}`}
            scroll={false}
            aria-current={t.id === active ? 'page' : undefined}
            data-tab={t.id}
            className={cn(
              'inline-flex items-center h-11 md:h-9 px-4 rounded-xl text-sm font-medium whitespace-nowrap',
              t.id === active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground active:bg-background/60 hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
