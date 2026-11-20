import Link from '@/components/intent-link';
import { cn } from '@/lib/utils';

type DataAttrs = { [k: `data-${string}`]: string | number | boolean | undefined };

/** The one surface: card radius, hairline border. Same on phone and desktop. `as="ul"` for a list of `<li>` rows. */
export function Card({ children, className, as: Tag = 'div', ...rest }: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'ul' | 'section' }) {
  return (
    <Tag className={cn('rounded-card bg-card border border-border/70 overflow-hidden min-w-0', className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Rows in a card, divided by hairlines. `as="ul"` when the rows are `<li>` (Row with `as="li"`). */
export function List({ children, className, ...rest }: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'ul' }) {
  return (
    <Card className={cn('divide-y divide-border/60', className)} {...rest}>
      {children}
    </Card>
  );
}

/**
 * One row: leading, title, one meta line, one trailing control. 44px high on phones, 36px from md
 * (taller when a meta line is shown). With `href` or `onClick` the row body is the target; the trailing control stays its own.
 * `detail` is an optional second, quieter line (a session's last line). `as="li"` inside a `List as="ul"`; data-* attributes
 * go on the outer element.
 */
export function Row({
  leading,
  title,
  meta,
  detail,
  trailing,
  href,
  onClick,
  className,
  as: Tag = 'div',
  ...rest
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  detail?: React.ReactNode;
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
  as?: 'div' | 'li';
} & DataAttrs) {
  const body = (
    <>
      {leading && <span className="shrink-0 flex items-center text-muted-foreground">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{title}</span>
        {meta && <span className="block truncate text-meta text-muted-foreground">{meta}</span>}
        {detail && <span className="block truncate text-meta text-muted-foreground/90">{detail}</span>}
      </span>
    </>
  );
  const pad = (meta || detail) && 'py-2';
  const base = cn('flex items-center gap-3 px-4 min-h-row min-w-0', className);
  // A tappable row: the padding sits inside the link or button, so the whole row height is its target.
  const main = cn('flex items-center gap-3 min-w-0 flex-1 self-stretch min-h-row', pad);
  const end = trailing ? <span className="shrink-0 flex items-center">{trailing}</span> : null;
  if (!href && !onClick) {
    return (
      <Tag className={cn(base, pad)} {...rest}>
        {body}
        {end}
      </Tag>
    );
  }
  return (
    <Tag className={cn(base, 'active:bg-muted/60')} {...rest}>
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
    </Tag>
  );
}
