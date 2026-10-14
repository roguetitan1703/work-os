import Link from 'next/link';
import { Bell, ChevronRight, Settings } from 'lucide-react';
import { listInbox } from '@/lib/notify';
import { fmtAgo } from '@/lib/format';
import { SubHeader } from '@/components/mobile/sub-header';
import { cn } from '@/lib/utils';
import { MarkRead } from './mark-read';

export const metadata = { title: 'Notifications · Work OS' };

const TONE: Record<string, string> = {
  overdue: 'bg-red-500',
  unblocked: 'bg-green-500',
  due_today: 'bg-blue-500',
  due_tomorrow: 'bg-sky-400',
  never_started: 'bg-orange-500',
  stalled: 'bg-amber-500',
  claude_code_changes: 'bg-violet-500',
  test: 'bg-muted-foreground',
};

export default async function NotificationsPage() {
  const items = await listInbox(150);
  const unread = items.filter(i => !i.read).length;
  return (
    <div className="max-w-xl mx-auto">
      <SubHeader
        back="/today"
        backLabel="Today"
        title="Notifications"
        bell={false}
        subtitle={unread ? `${unread} new` : 'All caught up'}
        right={
          <Link href="/settings" aria-label="Notification settings" className="w-10 h-10 flex items-center justify-center rounded-full active:bg-muted">
            <Settings className="w-5 h-5" />
          </Link>
        }
      />
      <div className="hidden md:flex items-center justify-between mb-3">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
          Settings
        </Link>
      </div>
      {unread > 0 && <MarkRead />}
      {items.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center text-muted-foreground">
          <Bell className="w-10 h-10 mb-3" />
          <div className="text-lg font-semibold text-foreground">No notifications yet</div>
          <div className="text-sm max-w-xs">Alerts about overdue, due, stalled and unblocked tasks show up here and on your phone.</div>
        </div>
      ) : (
        <ul className="mt-2 rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {items.map(i => (
            <li key={i.id}>
              <Link href={i.url} className={cn('flex items-start gap-3 px-4 py-3 active:bg-muted/60', !i.read && 'bg-blue-500/5')}>
                <span className={cn('mt-1.5 w-2.5 h-2.5 rounded-full shrink-0', TONE[i.kind] ?? 'bg-muted-foreground')} />
                <div className="flex-1 min-w-0">
                  <div className={cn('text-[15px] leading-snug', !i.read ? 'font-semibold text-foreground' : 'text-foreground/90')}>{i.title}</div>
                  {i.body && <div className="text-[13px] text-muted-foreground">{i.body}</div>}
                  <div className="text-[12px] text-muted-foreground mt-0.5" suppressHydrationWarning>
                    {fmtAgo(i.createdAt)}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 mt-1 text-muted-foreground/40" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
