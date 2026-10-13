import { differenceInDays, parseISO } from 'date-fns';
import { listTasks } from '@/lib/data/tasks';
import { TaskRow } from '@/components/task-row';
import { MTaskRow } from '@/components/mobile/m-task-row';

export default async function HiddenPage() {
  const today = new Date();
  const stale = (await listTasks({ open: true, sort: 'updated' }))
    .map(t => ({ t, days: differenceInDays(today, parseISO(t.updatedAt)) }))
    .filter(x => x.days > 7)
    .sort((a, b) => b.days - a.days);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Hidden Work</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Open tasks not touched in more than 7 days</p>
      </div>

      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
        Review every Sunday. Either re-prioritize, schedule, or drop.
      </div>

      {stale.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Nothing hidden — all open tasks touched within the last 7 days.</div>
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
