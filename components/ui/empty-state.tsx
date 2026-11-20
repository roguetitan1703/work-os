import { cn } from '@/lib/utils';

/** One line of what is missing and how it fills; optional icon and one action. */
export function EmptyState({ title, hint, icon, action, className }: { title: string; hint?: string; icon?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-card bg-card border border-border/70 px-6 py-8 text-center', className)}>
      {icon && <div className="mx-auto mb-3 w-11 h-11 rounded-pill bg-muted flex items-center justify-center text-muted-foreground">{icon}</div>}
      <div className="text-body font-medium text-foreground">{title}</div>
      {hint && <p className="text-meta text-muted-foreground mt-1">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
