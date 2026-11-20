import Link from '@/components/intent-link';
import { cn } from '@/lib/utils';

/** The one surface: card radius, hairline border. Same on phone and desktop. */
export function Card({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card bg-card border border-border/70 overflow-hidden min-w-0', className)} {...rest}>
      {children}
    </div>
  );
}

/** Rows in a card, divided by hairlines. */
export function List({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card className={cn('divide-y divide-border/60', className)} {...rest}>
      {children}
    </Card>
  );
}

/**
 * One row: leading, title, one meta line, one trailing control. 44px high on phones, 36px from md
 * (taller when a meta line is shown). With `href` or `onClick` the row body is the target; the trailing control stays its own.
 */
export function Row({
  leading,
  title,
  meta,
  trailing,
  href,
  onClick,
  className,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      {leading && <span className="shrink-0 flex items-center text-muted-foreground">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{title}</span>
        {meta && <span className="block truncate text-meta text-muted-foreground">{meta}</span>}
      </span>
    </>
  );
  const base = cn('flex items-center gap-3 px-4 min-h-row min-w-0', meta && 'py-2', className);
  const main = 'flex items-center gap-3 min-w-0 flex-1 self-stretch';
  const end = trailing ? <span className="shrink-0 flex items-center">{trailing}</span> : null;
  if (!href && !onClick) {
    return (
      <div className={base}>
        {body}
        {end}
      </div>
    );
  }
  return (
    <div className={cn(base, 'active:bg-muted/60')}>
      {href ? (
        <Link href={href} className={main}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={cn(main, 'text-left')}>
          {body}
        </button>
      )}
      {end}
    </div>
  );
}
