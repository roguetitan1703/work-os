import Link from '@/components/intent-link';
import { ChevronRight } from 'lucide-react';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { NavIcon, PLACE_ICON } from '@/components/nav-icons';
import { systemStatusLevel } from '@/lib/data/nav-counts';
import { unreadCount } from '@/lib/notify';
import { requireCaller } from '@/lib/caller';
import { isOperator } from '@/lib/operator';

export const metadata = { title: 'Menu · Work OS' };

const DOT = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500' } as const;
const DOT_TEXT = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;

/** Phone Menu: the things that are not a tab. Replaces the old More page. */
export default async function MenuPage() {
  const s = await requireCaller();
  // Server health is the operator's: everyone else gets no dot.
  const operator = isOperator(s);
  const [status, unread] = await Promise.all([operator ? systemStatusLevel(s).catch(() => 'ok' as const) : Promise.resolve('ok' as const), unreadCount(s).catch(() => 0)]);
  return (
    <div className="max-w-xl mx-auto">
      <MobileHeader title="Menu" />
      <h1 className="hidden md:block text-2xl font-bold mb-4">Menu</h1>

      <Group title="Inbox">
        <Row href="/notifications" icon={PLACE_ICON.inbox} label="Inbox" dot={unread > 0 ? <span className="text-xs rounded-full px-1.5 py-0.5 font-medium bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300">{unread}</span> : undefined} />
      </Group>

      <Group title="Review">
        <Row href="/review" icon={PLACE_ICON.review} label="Done · Activity · Stale · Archive · Trash" />
      </Group>

      <Group title="Schedule">
        <Row href="/timetable" icon={PLACE_ICON.schedule} label="Today's blocks and the week" />
      </Group>

      <Group title="Settings">
        <Row href="/settings" icon={PLACE_ICON.settings} label="Settings" dot={operator && status !== 'ok' ? <span role="img" aria-label={DOT_TEXT[status]} title={DOT_TEXT[status]} data-menu-status className={`w-2.5 h-2.5 rounded-full ${DOT[status]}`} /> : undefined} />
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

function Row({ href, label, icon, dot }: { href: string; label: string; icon: Parameters<typeof NavIcon>[0]['icon']; dot?: React.ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
      <NavIcon icon={icon} size={20} className="text-muted-foreground" />
      <span className="flex-1 min-w-0 truncate text-[16px] text-foreground">{label}</span>
      {dot}
      <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
    </Link>
  );
}
