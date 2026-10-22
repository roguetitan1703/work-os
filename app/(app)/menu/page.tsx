import Link from 'next/link';
import { ChevronRight, LifeBuoy } from 'lucide-react';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { MODE_LINKS } from '@/lib/nav';
import { systemStatusLevel } from '@/lib/data/nav-counts';
import { requireScope } from '@/lib/caller';

export const metadata = { title: 'Menu · Work OS' };

const DOT = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500' } as const;
const DOT_TEXT = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;

/** Phone Menu: the things that are not a tab. Replaces the old More page. */
export default async function MenuPage() {
  const status = await systemStatusLevel(await requireScope()).catch(() => 'ok' as const);
  return (
    <div className="max-w-xl mx-auto">
      <MobileHeader title="Menu" />
      <h1 className="hidden md:block text-2xl font-bold mb-4">Menu</h1>

      <Group title="Review">
        <Row href="/review" label="Done · Activity · Weekly · Stale · Archive · Trash" />
      </Group>

      <Group title="Schedule">
        <Row href="/timetable" label="Today's blocks and the week" />
      </Group>

      <Group title="Modes">
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {MODE_LINKS.map(m => (
            <Chip key={m.name} href={m.href}>
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.hex }} />
              {m.name}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="Settings">
        <Row href="/settings" label="Settings" dot={<span role="img" aria-label={DOT_TEXT[status]} title={DOT_TEXT[status]} className={`w-2.5 h-2.5 rounded-full ${DOT[status]}`} />} />

        <Row href="/settings?section=help" icon={<LifeBuoy className="w-5 h-5 text-pink-500" />} label="Help and recovery" />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="px-1 mb-1.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">{children}</div>
    </section>
  );
}

function Row({ href, label, icon, dot }: { href: string; label: string; icon?: React.ReactNode; dot?: React.ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
      {icon}
      <span className="flex-1 min-w-0 truncate text-[16px] text-foreground">{label}</span>
      {dot}
      <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
    </Link>
  );
}

function Chip({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="h-11 px-4 inline-flex items-center gap-2 rounded-full border border-border bg-background text-sm font-medium text-foreground active:scale-95 transition-transform">
      {children}
    </Link>
  );
}
