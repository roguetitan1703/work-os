import Link from 'next/link';
import { cn } from '@/lib/utils';

/** Phone-only `Projects | Notes` segment. Both are their own routes; switching replaces, so Back leaves the hub. */
export function HubSegment({ active }: { active: 'projects' | 'notes' }) {
  return (
    <div className="md:hidden grid grid-cols-2 gap-1 rounded-xl bg-muted/70 p-1" role="tablist" aria-label="Projects and notes">
      {(['projects', 'notes'] as const).map(k => (
        <Link
          key={k}
          href={`/${k}`}
          replace
          role="tab"
          aria-selected={active === k}
          className={cn('h-11 flex items-center justify-center rounded-lg text-[15px] font-medium capitalize', active === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          {k}
        </Link>
      ))}
    </div>
  );
}
