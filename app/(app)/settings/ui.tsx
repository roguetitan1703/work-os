import { cn } from '@/lib/utils';

export type Level = 'ok' | 'warn' | 'error' | 'off';

const DOT: Record<Level, string> = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500', off: 'bg-muted-foreground/40' };
const TEXT: Record<Level, string> = {
  ok: 'text-green-700 dark:text-green-300',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'text-red-700 dark:text-red-300',
  off: 'text-muted-foreground',
};

export function Dot({ level, className }: { level: Level; className?: string }) {
  return <span aria-hidden className={cn('inline-block w-2.5 h-2.5 rounded-full shrink-0', DOT[level], className)} />;
}

/** Muted section label, as on Settings and More. */
export function Label({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 mb-1.5 text-[13px] font-medium text-muted-foreground">{children}</h2>;
}

export function Section({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mt-5 first:mt-0 min-w-0', className)}>
      {title && <Label>{title}</Label>}
      {children}
    </section>
  );
}

/** Rounded-2xl card; `grouped` divides direct children into rows. */
export function Card({ children, grouped, className }: { children: React.ReactNode; grouped?: boolean; className?: string }) {
  return (
    <div className={cn('rounded-2xl bg-card border border-border/70 overflow-hidden min-w-0', grouped && 'divide-y divide-border/60', className)}>{children}</div>
  );
}

/** One-line status banner: dot + plain words. */
export function StatusLine({ level, title, children }: { level: Level; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 min-h-14">
      <Dot level={level} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className={cn('text-[15px] font-medium', TEXT[level])}>{title}</div>
        {children && <div className="text-[13px] text-muted-foreground leading-snug mt-0.5 space-y-0.5">{children}</div>}
      </div>
    </div>
  );
}

export { Disclosure } from '@/components/ui/disclosure'; // moved to the shared library

/** A labelled copy row: label above, CopyBox below. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

export const code = 'px-1 rounded bg-muted text-[0.85em] font-mono';
