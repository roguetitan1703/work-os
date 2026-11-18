import { cn } from '@/lib/utils';

/**
 * A small "New" mark next to a feature for its first days (lib/whats-new.ts NEW_DAYS). Not dismissible. The caller
 * decides whether it shows (`on`: the place is in whatsNewState().badges, or the app context's `newBadges`).
 */
export function NewBadge({ on = true, className }: { on?: boolean; className?: string }) {
  if (!on) return null;
  return (
    <span data-new-badge className={cn('inline-flex items-center shrink-0 text-[11px] leading-none font-medium px-1.5 py-[3px] rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400', className)}>
      New
    </span>
  );
}
