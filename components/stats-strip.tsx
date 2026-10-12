import Link from 'next/link';
import type { Stats } from '@/lib/data/summary';
import { cn } from '@/lib/utils';

export function StatsStrip({ stats }: { stats: Stats }) {
  const items = [
    { label: 'Overdue', value: stats.overdue, href: '/board?due=overdue', tone: stats.overdue ? 'text-red-600 dark:text-red-400' : '' },
    { label: 'Due today', value: stats.dueToday, href: '/board?due=today', tone: '' },
    { label: 'In progress', value: stats.inProgress, href: '/board', tone: 'text-blue-600 dark:text-blue-400' },
    { label: 'Blocked', value: stats.blocked, href: '/board', tone: stats.blocked ? 'text-red-600 dark:text-red-400' : '' },
    {
      label: 'Done this week',
      value: stats.completedThisWeek,
      href: '/history',
      tone: 'text-green-600 dark:text-green-400',
      sub: `last week ${stats.completedLastWeek}`,
    },
    { label: 'Open', value: stats.openTotal, href: '/board', tone: '', sub: `${stats.p1Open} P1` },
  ];
  return (
    <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
      {items.map(i => (
        <Link key={i.label} href={i.href} className="rounded-lg border border-border bg-card px-3 py-2 hover:bg-muted/50 transition-colors">
          <div className="text-[11px] text-muted-foreground">{i.label}</div>
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-xl font-semibold tabular-nums', i.tone)}>{i.value}</span>
            {i.sub && <span className="text-[11px] text-muted-foreground">{i.sub}</span>}
          </div>
        </Link>
      ))}
    </div>
  );
}
