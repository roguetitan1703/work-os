import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Marks a private project (only its owner sees it). Shared projects get no mark. `compact`: the lock alone, for tight rows. */
export function PrivateBadge({ compact, className }: { compact?: boolean; className?: string }) {
  if (compact) return <Lock data-private-badge className={cn('w-3 h-3 shrink-0 inline-block align-[-1px]', className)} aria-label="Private project" role="img" />;
  return (
    <span data-private-badge className={cn('inline-flex items-center gap-1 shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground', className)}>
      <Lock className="w-3 h-3" aria-hidden /> Private
    </span>
  );
}

/** Plain-text mark for places that cannot hold an icon (a native option list). */
export const privateSuffix = (isPrivate: boolean | undefined): string => (isPrivate ? ' (private)' : '');
