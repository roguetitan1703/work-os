import Link from 'next/link';
import { cn } from '@/lib/utils';

export const REVIEW_LINKS = [
  { key: 'done', label: 'Done', href: '/review?view=done' },
  { key: 'activity', label: 'Activity', href: '/review?view=activity' },
  { key: 'weekly', label: 'Weekly', href: '/review?view=weekly' },
  { key: 'stale', label: 'Stale', href: '/review?view=stale' },
  { key: 'archive', label: 'Archive', href: '/review?view=archive' },
  { key: 'trash', label: 'Trash', href: '/review?view=trash' },
] as const;

export type ReviewView = (typeof REVIEW_LINKS)[number]['key'];

/** ?view= value to a segment. "history" is the old name for Done; anything unknown is Done. */
export function reviewView(v: string | undefined): ReviewView {
  if (v === 'history') return 'done';
  return REVIEW_LINKS.find(l => l.key === v)?.key ?? 'done';
}

/** The Review hub strip: Done, Activity, Weekly, Stale, Archive, Trash. Replace navigation, like a segment. */
export function ReviewNav({ active }: { active: ReviewView }) {
  return (
    <nav aria-label="Review" className="flex gap-1 bg-muted rounded-xl md:rounded-lg p-1 overflow-x-auto md:w-fit [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {REVIEW_LINKS.map(l => (
        <Link
          key={l.key}
          href={l.href}
          replace
          aria-current={active === l.key ? 'page' : undefined}
          className={cn(
            'h-11 md:h-auto shrink-0 flex-1 md:flex-none flex items-center justify-center px-2 md:px-3 md:py-1 rounded-lg md:rounded text-[13px] md:text-sm font-medium whitespace-nowrap transition-colors',
            active === l.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
