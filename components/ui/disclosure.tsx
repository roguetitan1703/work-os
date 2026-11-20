import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Native <details> disclosure in a card (no JS). Moved from Settings; `settings/ui.tsx` re-exports it. */
export function Disclosure({ title, hint, open, children, className }: { title: string; hint?: string; open?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <details open={open} className={cn('group rounded-card bg-card border border-border/70 overflow-hidden min-w-0', className)}>
      <summary className="flex items-center gap-3 px-4 min-h-14 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-muted/60">
        <span className="flex-1 min-w-0">
          <span className="block text-body font-medium text-foreground">{title}</span>
          {hint && <span className="block text-meta text-muted-foreground leading-snug truncate">{hint}</span>}
        </span>
        <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180 shrink-0" />
      </summary>
      <div className="border-t border-border/60 px-4 py-4 space-y-3 text-sm text-foreground/90 min-w-0">{children}</div>
    </details>
  );
}
