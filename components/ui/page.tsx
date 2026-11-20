import { ChevronLeft } from 'lucide-react';
import { BackLink } from '@/components/back-link';
import { cn } from '@/lib/utils';

/** One page width for every screen (max-w-page); the layout supplies the gutter. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-page min-w-0 space-y-5', className)}>{children}</div>;
}

/**
 * The one back link: a chevron and the parent's name, 44px on phones and 36px from md. Goes back in history when the
 * last page was in the app, else to `href`. Every page uses this one (PageHeader, the phone header, task and note pages).
 */
export function BackButton({ href, label = 'Back', className }: { href: string; label?: string; className?: string }) {
  return (
    <BackLink href={href} aria-label={label === 'Back' ? 'Back' : `Back to ${label}`} className={cn('-ml-2 inline-flex items-center h-11 md:h-9 max-w-full pl-1 pr-3 gap-0.5 rounded-control text-body text-blue-600 dark:text-blue-400 hover:opacity-80 active:opacity-60', className)}>
      <ChevronLeft className="w-5 h-5 shrink-0" strokeWidth={2.2} />
      <span className="truncate">{label}</span>
    </BackLink>
  );
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
      {back && <BackButton href={back} label={backLabel} className="mb-0.5" />}
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-page font-semibold tracking-tight text-foreground truncate">{title}</h1>
          {sub && <div className="text-meta text-muted-foreground mt-0.5">{sub}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
