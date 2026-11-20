'use client';

import { cn } from '@/lib/utils';

/** A filter or choice chip. One selected style: filled with the foreground colour. */
export function Chip({
  selected,
  onClick,
  children,
  className,
  disabled,
  ...rest
}: { selected?: boolean; onClick?: () => void; children: React.ReactNode; className?: string; disabled?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-9 md:h-8 px-3.5 md:px-3 inline-flex items-center justify-center gap-1.5 rounded-pill border text-meta font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-50',
        selected ? 'bg-foreground text-background border-foreground' : 'bg-background text-foreground border-border hover:bg-muted',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A row of chips: wraps by default; `scroll` keeps one swipeable line (phone filter bars). */
export function ChipGroup({ children, scroll, label, className }: { children: React.ReactNode; scroll?: boolean; label?: string; className?: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex gap-2 min-w-0', scroll ? 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'flex-wrap', className)}
    >
      {children}
    </div>
  );
}
