import { ChevronLeft } from 'lucide-react';
import { BackLink } from '@/components/back-link';
import { cn } from '@/lib/utils';

/** One page width for every screen (max-w-page); the layout supplies the gutter. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-page min-w-0 space-y-5', className)}>{children}</div>;
}

/** Title, one sub line, optional back link and actions. Same on phone and desktop. */
export function PageHeader({
  title,
  sub,
  back,
  backLabel = 'Back',
  actions,
  className,
}: {
  title: string;
  sub?: React.ReactNode;
  back?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('min-w-0', className)}>
      {back && (
        <BackLink href={back} aria-label={`Back to ${backLabel}`} className="-ml-2 mb-0.5 inline-flex items-center h-11 md:h-9 pl-1 pr-3 gap-0.5 rounded-control text-body text-blue-600 dark:text-blue-400 active:opacity-60">
          <ChevronLeft className="w-5 h-5" strokeWidth={2.2} />
          {backLabel}
        </BackLink>
      )}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-page font-semibold tracking-tight text-foreground truncate">{title}</h1>
          {sub && <p className="text-meta text-muted-foreground mt-0.5">{sub}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
