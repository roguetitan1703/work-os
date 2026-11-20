import { BackButton } from '../ui/page';

// Screens reached from the Menu or a parent use MobileHeader (components/mobile/tab-bar.tsx) with `back`: the same
// header as a top-level screen, with the one back link (BackButton) above the title.

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

/** Sticky phone back bar for editor-style pages that carry their own title (e.g. a note): the one back link. */
export function MobileBack({ href, label }: { href: string; label: string }) {
  return (
    <div className="md:hidden sticky top-0 z-30 -mx-4 -mt-3 px-4 bg-background/85 backdrop-blur-xl" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <BackButton href={href} label={label} />
    </div>
  );
}
