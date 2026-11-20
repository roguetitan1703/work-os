import { ChevronRight } from 'lucide-react';
import { ScreenHeader } from '@/components/mobile/tab-bar';
import { NavIcon, PLACE_ICON } from '@/components/nav-icons';
import { List, Row } from '@/components/ui/card';
import { systemStatusLevel } from '@/lib/data/nav-counts';
import { unreadCount } from '@/lib/notify';
import { requireCaller } from '@/lib/caller';
import { isOperator } from '@/lib/operator';
import { whatsNewState } from '@/lib/whats-new-seen';

export const metadata = { title: 'Menu · Work OS' };

const DOT = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500' } as const;
const DOT_TEXT = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;

/** Phone Menu: one flat list of the places that are not a tab (Tasks first). */
export default async function MenuPage() {
  const s = await requireCaller();
  // Server health is the operator's: everyone else gets no dot.
  const operator = isOperator(s);
  const [status, unread, news] = await Promise.all([operator ? systemStatusLevel(s).catch(() => 'ok' as const) : Promise.resolve('ok' as const), unreadCount(s).catch(() => 0), whatsNewState(s).catch(() => null)]);
  const rows: { href: string; label: string; icon: Parameters<typeof NavIcon>[0]['icon']; mark?: React.ReactNode }[] = [
    { href: '/tasks', label: 'Tasks', icon: PLACE_ICON.tasks },
    { href: '/notes', label: 'Notes', icon: PLACE_ICON.notes },
    { href: '/review', label: 'Review', icon: PLACE_ICON.review },
    { href: '/timetable', label: 'Schedule', icon: PLACE_ICON.schedule },
    {
      href: '/notifications',
      label: 'Inbox',
      icon: PLACE_ICON.inbox,
      mark: unread > 0 ? <span data-inbox-count className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-label font-semibold leading-[18px] text-center">{unread > 99 ? '99+' : unread}</span> : undefined,
    },
    { href: '/whats-new', label: "What's new", icon: PLACE_ICON.whatsnew, mark: news?.unseen.length ? <span data-new-dot role="img" aria-label="Something new" className="w-2.5 h-2.5 rounded-full bg-blue-500" /> : undefined },
    {
      href: '/settings',
      label: 'Settings',
      icon: PLACE_ICON.settings,
      mark: operator && status !== 'ok' ? <span role="img" aria-label={DOT_TEXT[status]} title={DOT_TEXT[status]} data-menu-status className={`w-2.5 h-2.5 rounded-full ${DOT[status]}`} /> : undefined,
    },
  ];
  return (
    <div className="max-w-xl mx-auto space-y-5">
      <ScreenHeader title="Menu" />
      <List data-menu>
        {rows.map(r => (
          <Row
            key={r.href}
            href={r.href}
            leading={<NavIcon icon={r.icon} size={20} />}
            title={
              // The count or dot and the chevron sit inside the link: the whole row is one target.
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.mark}
                <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground/40" aria-hidden />
              </span>
            }
          />
        ))}
      </List>
    </div>
  );
}
