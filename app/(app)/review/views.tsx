import Link from '@/components/intent-link';
import { differenceInDays, parseISO, format } from 'date-fns';
import { EyeOff, Trash2 } from 'lucide-react';
import { listActivity, listTasks, listTrash, TRASH_DAYS } from '@/lib/data/tasks';
import { projectNameMap } from '@/lib/data/projects';
import { requireScope } from '@/lib/caller';
import { ActorName } from '@/components/actor-badge';
import { ACTOR_FILTERS, type ActorFilter } from '@/lib/actors';
import { fmtAgo, fmtDate, fmtDateTime } from '@/lib/format';
import { PurgeTrashButton, RestoreTrashButton } from '@/components/trash-controls';
import { addDays, dateInTz, startOfDay, todayStr, weekStart } from '@/lib/dates';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList, TaskRow } from '@/components/task-row';
import { MTaskRow } from '@/components/mobile/m-task-row';
import { UNTOUCHED_DAYS, isUntouched } from '@/lib/untouched';
import { cn } from '@/lib/utils';
import { MEmpty } from '@/components/mobile/sub-header';
import { UnarchiveButton } from './unarchive-button';

export async function Completed({ weeks }: { weeks: number }) {
  const today = todayStr();
  const from = addDays(weekStart(today), -7 * (weeks - 1));
  const done = await listTasks(await requireScope(), { status: ['Done'], doneFrom: from, sort: 'done', archived: 'include' });
  const groups = new Map<string, typeof done>();
  for (const t of done) {
    const wk = weekStart(t.doneOn ?? today);
    groups.set(wk, [...(groups.get(wk) ?? []), t]);
  }
  const allWeeks = Array.from({ length: weeks }, (_, i) => addDays(weekStart(today), -7 * i));
  const max = Math.max(1, ...allWeeks.map(w => groups.get(w)?.length ?? 0));

  return (
    <div className="space-y-6">
      {/* weekly throughput */}
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card p-4">
        <div className="text-sm md:text-xs text-muted-foreground mb-3">Completed per week</div>
        <div className="flex items-end gap-2 h-24">
          {[...allWeeks].reverse().map(w => {
            const n = groups.get(w)?.length ?? 0;
            return (
              <div key={w} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <span className="text-[10px] tabular-nums text-muted-foreground">{n || ''}</span>
                <div className="w-full rounded-t bg-green-500/70" style={{ height: `${(n / max) * 64}px`, minHeight: n ? 2 : 0 }} />
                <span className="text-[10px] text-muted-foreground truncate">{format(parseISO(w), 'MMM d')}</span>
              </div>
            );
          })}
        </div>
      </div>
      {allWeeks
        .filter(w => groups.has(w))
        .map(w => (
          <section key={w} className="space-y-1">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Week of {format(parseISO(w), 'MMM d, yyyy')} · {groups.get(w)!.length}
            </h2>
            <TaskList tasks={groups.get(w)!} />
          </section>
        ))}
      {!done.length && <MEmpty title="Nothing completed yet" hint="Finished tasks show up here, grouped by week." />}
      <Link
        href={`/review?view=done&weeks=${weeks + 8}`}
        className="flex md:inline h-12 md:h-auto items-center justify-center rounded-2xl md:rounded-none border border-border/70 md:border-0 bg-card md:bg-transparent text-sm md:text-xs md:underline text-muted-foreground active:bg-muted/60"
      >
        Show older
      </Link>
    </div>
  );
}

export async function Activity({ actor }: { actor?: string }) {
  const a = (ACTOR_FILTERS as readonly string[]).includes(actor ?? '') ? (actor as ActorFilter) : undefined;
  const since = startOfDay(addDays(todayStr(), -14));
  const items = await listActivity(await requireScope(), { since, actor: a, limit: 400 });
  const byDay = new Map<string, typeof items>();
  for (const i of items) {
    const d = dateInTz(new Date(i.at));
    byDay.set(d, [...(byDay.get(d) ?? []), i]);
  }
  return (
    <div className="space-y-5">
      <div className="flex gap-2 text-sm md:text-xs overflow-x-auto md:overflow-visible -mx-4 px-4 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[undefined, 'me', 'discord', 'claude', 'claude-code'].map(x => (
          <Link
            key={x ?? 'all'}
            href={`/review?view=activity${x ? `&actor=${x}` : ''}`}
            replace
            className={cn(
              'shrink-0 whitespace-nowrap h-11 md:h-auto px-4 md:px-2 md:py-1 inline-flex items-center rounded-full md:rounded border',
              a === x ? 'bg-foreground text-background border-foreground md:bg-muted md:text-foreground md:border-border' : 'border-border text-muted-foreground bg-card md:bg-transparent',
            )}
          >
            {x === 'me' ? 'By me (app)' : x === 'discord' ? 'By me (Discord)' : x === 'claude' ? 'By Claude' : x === 'claude-code' ? 'By Claude Code' : 'Everyone'}
          </Link>
        ))}
        <span className="hidden md:inline text-muted-foreground self-center">Last 14 days</span>
      </div>
      <p className="md:hidden -mt-2 px-1 text-xs text-muted-foreground">Last 14 days</p>
      {[...byDay].map(([d, list]) => (
        <section key={d} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{format(parseISO(d), 'EEEE, MMM d')}</h2>
          <ActivityTimeline items={list} showTask />
        </section>
      ))}
      {!items.length && <MEmpty title="No activity" hint="Nothing changed in the last 14 days." />}
    </div>
  );
}

export async function Trash() {
  const s = await requireScope();
  const [items, names] = await Promise.all([listTrash(s), projectNameMap(s)]);
  return (
    <div className="space-y-2">
      <p className="text-sm md:text-xs text-muted-foreground px-1 md:px-0">
        {`Deleted tasks stay here for ${TRASH_DAYS} days with their history, then they're gone for good.`}
      </p>
      {items.length ? (
        <ul className="divide-y divide-border/60 md:divide-border rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden">
          {items.map(t => {
            const project = t.projectId ? names.get(t.projectId) : null;
            return (
              <li key={t.ref} className="flex flex-col md:flex-row items-stretch md:items-start gap-3 px-4 md:px-3 py-3 md:py-2.5">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-[16px] md:text-sm text-foreground md:truncate">
                    <span className="font-mono text-muted-foreground">#{t.ref}</span> {t.title}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap text-xs md:text-[11px] text-muted-foreground">
                    {project && <span className="text-foreground/80">{project}</span>}
                    {project && <span>·</span>}
                    <span title={fmtDateTime(t.deletedAt)}>
                      deleted {fmtAgo(t.deletedAt)} by <ActorName actor={t.deletedBy} />
                    </span>
                    <span>·</span>
                    <span>purged on {fmtDate(t.purgeOn, 'MMM d')}</span>
                  </div>
                  {t.reason && <p className="text-xs text-muted-foreground italic">&ldquo;{t.reason}&rdquo;</p>}
                </div>
                <div className="flex items-center gap-2 md:gap-1 md:shrink-0">
                  <RestoreTrashButton taskRef={t.ref} />
                  <PurgeTrashButton taskRef={t.ref} title={t.title} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <MEmpty icon={<Trash2 className="w-5 h-5" />} title="Trash is empty" hint={`Deleted tasks show up here for ${TRASH_DAYS} days.`} />
      )}
    </div>
  );
}
export async function Archived() {
  const s = await requireScope();
  const [tasks, names] = await Promise.all([listTasks(s, { archived: 'only', sort: 'updated' }), projectNameMap(s)]);
  return (
    <div className="space-y-2">
      <p className="text-sm md:text-xs text-muted-foreground px-1 md:px-0">Archived tasks are hidden everywhere else. Restore one to bring it back.</p>
      {tasks.length ? (
        <ul className="divide-y divide-border/60 md:divide-border rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden">
          {tasks.map(t => (
            <li key={t.id} data-archived-row className="flex items-center gap-2 px-4 md:px-3 min-h-14 md:min-h-0 py-1 md:py-1.5">
              <Link href={`/tasks/${t.ref}`} className="min-w-0 flex-1 py-2 block">
                <div className="text-[16px] md:text-sm text-foreground truncate">
                  <span className="font-mono text-muted-foreground">#{t.ref}</span> {t.title}
                </div>
                <div className="text-xs md:text-[11px] text-muted-foreground truncate">
                  {[t.status, t.projectId ? names.get(t.projectId) : null, `archived ${fmtAgo(t.updatedAt)}`].filter(Boolean).join(' · ')}
                </div>
              </Link>
              <UnarchiveButton id={t.id} taskRef={t.ref} />
            </li>
          ))}
        </ul>
      ) : (
        <MEmpty title="Nothing archived" hint="Archived tasks show up here." />
      )}
    </div>
  );
}

export async function Stale() {
  const now = new Date();
  const stale = (await listTasks(await requireScope(), { open: true, sort: 'updated' }))
    .map(t => ({ t, days: differenceInDays(now, parseISO(t.updatedAt)) }))
    .filter(x => isUntouched(x.t.updatedAt, now.getTime()))
    .sort((a, b) => b.days - a.days);

  return (
    <div className="space-y-5 md:space-y-6">
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
