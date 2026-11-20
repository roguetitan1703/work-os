import { ChevronDown } from 'lucide-react';
import Link from '@/components/intent-link';
import { cn } from '@/lib/utils';

/** A labelled group: label (sentence case), optional count, "See all", optional fold (native details, no JS). */
export function Section({
  label,
  count,
  seeAll,
  seeAllLabel = 'See all',
  fold,
  defaultOpen = true,
  children,
  className,
}: {
  label: string;
  count?: number;
  seeAll?: string;
  seeAllLabel?: string;
  /** Makes the label a fold toggle. */
  fold?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const head = (
    <>
      <h2 className="text-meta font-medium text-muted-foreground">{label}</h2>
      {count !== undefined && <span className="text-meta text-muted-foreground/70 tabular-nums">{count}</span>}
    </>
  );
  const link = seeAll ? (
    <Link href={seeAll} className="ml-auto h-8 -mr-2 px-2 inline-flex items-center text-meta text-blue-600 dark:text-blue-400 active:opacity-60">
      {seeAllLabel}
    </Link>
  ) : null;
  if (fold) {
    return (
      <details open={defaultOpen} className={cn('group min-w-0', className)}>
        <summary className="flex items-center gap-2 px-1 mb-1.5 min-h-8 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          {head}
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          {link}
        </summary>
        {children}
      </details>
    );
  }
  return (
    <section className={cn('min-w-0', className)}>
      <div className="flex items-center gap-2 px-1 mb-1.5 min-h-8">
        {head}
        {link}
      </div>
      {children}
    </section>
  );
}
