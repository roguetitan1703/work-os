import Link from 'next/link';
import { cn } from '@/lib/utils';

export const REVIEW_LINKS = [
  { key: 'completed', label: 'Done', href: '/history?tab=completed' },
  { key: 'activity', label: 'Activity', href: '/history?tab=activity' },
  { key: 'weekly', label: 'Weekly', href: '/review' },
  { key: 'stale', label: 'Untouched', href: '/hidden' },
  { key: 'archived', label: 'Archive', href: '/history?tab=archived' },
  { key: 'trash', label: 'Trash', href: '/history?tab=trash' },
] as const;

/** The Review hub strip: Done, Activity, Weekly, Untouched, Archive, Trash. Replace navigation, like a segment. */
export function ReviewNav({ active }: { active: (typeof REVIEW_LINKS)[number]['key'] }) {
  return (
    <nav aria-label="Review" className="flex gap-1 bg-muted rounded-xl md:rounded-lg p-1 overflow-x-auto md:w-fit [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {REVIEW_LINKS.map(l => (
        <Link
          key={l.key}
          href={l.href}
          replace
          aria-current={active === l.key ? 'page' : undefined}
          className={cn(
            'h-11 md:h-auto shrink-0 flex-1 md:flex-none flex items-center justify-center px-3 md:py-1 rounded-lg md:rounded text-[13px] md:text-sm font-medium whitespace-nowrap transition-colors',
            active === l.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
