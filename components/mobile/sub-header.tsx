import { BackLink } from '@/components/back-link';
import { ChevronLeft } from 'lucide-react';
import { MobileHeader } from './tab-bar';

/**
 * Phone header for screens reached from the Menu (or a parent screen): a 44px back button above the big title.
 * Phone only; pages keep their own desktop heading.
 */
export function SubHeader({
  title,
  subtitle,
  back = '/menu',
  backLabel = 'Menu',
  right,
  bell,
}: {
  title: string;
  subtitle?: React.ReactNode;
  back?: string;
  backLabel?: string;
  right?: React.ReactNode;
  bell?: boolean;
}) {
  return (
    <div className="contents md:hidden">
      <div className="relative z-40 md:hidden -mx-4 -mt-3 px-2" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <BackLink href={back} aria-label={`Back to ${backLabel}`} className="inline-flex items-center h-11 pl-1 pr-3 gap-0.5 rounded-xl text-[16px] text-blue-600 dark:text-blue-400 active:opacity-60">
          <ChevronLeft className="w-6 h-6" strokeWidth={2.2} />
          {backLabel}
        </BackLink>
      </div>
      <div className="contents [&>header]:mt-[calc(-1*(env(safe-area-inset-top)+0.75rem))]!">
        <MobileHeader title={title} subtitle={subtitle} right={right} bell={bell} nav={false} />
      </div>
    </div>
  );
}

/** Phone empty state inside a card. */
export function MEmpty({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-card border border-border/70 px-6 py-10 text-center">
      {icon && <div className="mx-auto mb-3 w-11 h-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground">{icon}</div>}
      <div className="text-[16px] font-medium text-foreground">{title}</div>
      {hint && <p className="text-sm text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

/** Small uppercase group title, matching the Menu. */
export function MGroupTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>;
}

/** Sticky phone back bar for editor-style pages that carry their own title (e.g. a note). */
export function MobileBack({ href, label }: { href: string; label: string }) {
  return (
    <div
      className="md:hidden sticky top-0 z-30 -mx-4 -mt-3 px-2 bg-background/85 backdrop-blur-xl"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <BackLink href={href} aria-label={`Back to ${label}`} className="inline-flex items-center h-11 max-w-full pl-1 pr-3 gap-0.5 rounded-xl text-[16px] text-blue-600 dark:text-blue-400 active:opacity-60">
        <ChevronLeft className="w-6 h-6 shrink-0" strokeWidth={2.2} />
        <span className="truncate">{label}</span>
      </BackLink>
    </div>
  );
}
