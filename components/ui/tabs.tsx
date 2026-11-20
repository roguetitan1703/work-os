import Link from '@/components/intent-link';
import { cn } from '@/lib/utils';

export type TabItem = { key: string; label: string; href: string; count?: number };

/**
 * One segment for every tab strip. URL-driven: each tab is a link, `active` comes from the URL (searchParams or the
 * path), so Back and refresh keep it. Up to four tabs share the width; more scroll sideways, never squeeze.
 */
export function Tabs({ items, active, label, className }: { items: TabItem[]; active: string; label: string; className?: string }) {
  const fit = items.length <= 4;
  return (
    <div className={cn('rounded-control bg-muted/70 p-1 min-w-0', !fit && 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} role="tablist" aria-label={label}>
      <div className={cn(fit ? 'grid gap-1' : 'flex gap-1 w-max min-w-full')} style={fit ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined}>
        {items.map(t => {
          const on = t.key === active;
          return (
            <Link
              key={t.key}
              href={t.href}
              replace
              role="tab"
              aria-selected={on}
              className={cn(
                'h-9 md:h-8 px-3 flex items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-4px)] text-body md:text-meta font-medium whitespace-nowrap',
                on ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground',
              )}
            >
              {t.label}
              {t.count !== undefined && <span className="text-label tabular-nums text-muted-foreground">{t.count}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
