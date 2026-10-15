import { differenceInDays, parseISO } from 'date-fns';
import { UNTOUCHED_DAYS, isUntouched } from '@/lib/untouched';
import { EyeOff } from 'lucide-react';
import { listTasks } from '@/lib/data/tasks';
import { TaskRow } from '@/components/task-row';
import { MTaskRow } from '@/components/mobile/m-task-row';
import { SubHeader, MEmpty } from '@/components/mobile/sub-header';
import { ReviewNav } from '@/components/review-nav';

export const metadata = { title: 'Untouched · Work OS' };

export default async function HiddenPage() {
  const now = new Date();
  const stale = (await listTasks({ open: true, sort: 'updated' }))
    .map(t => ({ t, days: differenceInDays(now, parseISO(t.updatedAt)) }))
    .filter(x => isUntouched(x.t.updatedAt, now.getTime()))
    .sort((a, b) => b.days - a.days);

  return (
    <div className="space-y-5 md:space-y-6 max-w-5xl">
      <SubHeader title="Untouched" subtitle={stale.length ? `${stale.length} untouched for over ${UNTOUCHED_DAYS} days` : `Open tasks untouched for over ${UNTOUCHED_DAYS} days`} />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Untouched</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Open tasks not touched in more than {UNTOUCHED_DAYS} days</p>
      </div>

      <ReviewNav active="stale" />

      <div className="rounded-2xl md:rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 md:py-2.5 text-sm text-amber-800 dark:text-amber-300">
        Review every Sunday. Either re-prioritize, schedule, or drop.
      </div>

      {stale.length === 0 ? (
        <>
          <div className="md:hidden">
            <MEmpty icon={<EyeOff className="w-5 h-5" />} title="Nothing untouched" hint={`All open tasks were touched in the last ${UNTOUCHED_DAYS} days.`} />
          </div>
          <div className="hidden md:block text-sm text-muted-foreground py-12 text-center">Nothing untouched — all open tasks touched within the last {UNTOUCHED_DAYS} days.</div>
        </>
      ) : (
        <>
        <div className="md:hidden rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {stale.map(({ t, days }) => (
            <MTaskRow
              key={t.id}
              task={t}
              hint={<span className={days > 30 ? 'text-red-600 dark:text-red-400' : days > 14 ? 'text-amber-600 dark:text-amber-400' : ''}>untouched {days}d</span>}
            />
          ))}
        </div>
        <div className="hidden md:block space-y-0.5">
          {stale.map(({ t, days }) => (
            <TaskRow
              key={t.id}
              task={t}
              hint={
                <span className={days > 30 ? 'text-red-600 dark:text-red-400' : days > 14 ? 'text-amber-600 dark:text-amber-400' : ''}>
                  untouched {days}d
                </span>
              }
            />
          ))}
        </div>
        </>
      )}
    </div>
  );
}
