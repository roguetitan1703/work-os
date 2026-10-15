import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import { listActivity, listTasks, listTrash, TRASH_DAYS } from '@/lib/data/tasks';
import { projectNameMap } from '@/lib/data/projects';
import { ACTOR_LABEL } from '@/lib/activity-text';
import { fmtAgo, fmtDate, fmtDateTime } from '@/lib/format';
import { PurgeTrashButton, RestoreTrashButton } from '@/components/trash-controls';
import { addDays, dateInTz, startOfDay, todayStr, weekStart } from '@/lib/dates';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList } from '@/components/task-row';
import { cn } from '@/lib/utils';
import { SubHeader, MEmpty } from '@/components/mobile/sub-header';
import { Trash2 } from 'lucide-react';
import { ReviewNav } from '@/components/review-nav';

type Tab = 'completed' | 'activity' | 'archived' | 'trash';
type Props = { searchParams: Promise<{ tab?: string; actor?: string; weeks?: string }> };

export const metadata = { title: 'Review · Work OS' };

export default async function HistoryPage({ searchParams }: Props) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === 'activity' || sp.tab === 'archived' || sp.tab === 'trash' ? sp.tab : 'completed';
  const weeks = Math.min(52, Math.max(1, Number(sp.weeks) || 8));

  return (
    <div className="space-y-5 max-w-5xl">
      <SubHeader title="Review" subtitle="How work actually moved." />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Review</h1>
        <p className="text-sm text-muted-foreground mt-0.5">How work actually moved.</p>
      </div>
      <ReviewNav active={tab} />
      {tab === 'completed' && <Completed weeks={weeks} />}
      {tab === 'activity' && <ActivityFeed actor={sp.actor} />}
      {tab === 'archived' && <Archived />}
      {tab === 'trash' && <Trash />}
    </div>
  );
}

async function Completed({ weeks }: { weeks: number }) {
  const today = todayStr();
  const from = addDays(weekStart(today), -7 * (weeks - 1));
  const done = await listTasks({ status: ['Done'], doneFrom: from, sort: 'done', archived: 'include' });
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
        href={`/history?tab=completed&weeks=${weeks + 8}`}
        className="flex md:inline h-12 md:h-auto items-center justify-center rounded-2xl md:rounded-none border border-border/70 md:border-0 bg-card md:bg-transparent text-sm md:text-xs md:underline text-muted-foreground active:bg-muted/60"
      >
        Show older
      </Link>
    </div>
  );
}

async function ActivityFeed({ actor }: { actor?: string }) {
  const a = actor === 'me' || actor === 'discord' || actor === 'claude' || actor === 'claude-code' || actor === 'system' ? actor : undefined;
  const since = startOfDay(addDays(todayStr(), -14));
  const items = await listActivity({ since, actor: a, limit: 400 });
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
            href={`/history?tab=activity${x ? `&actor=${x}` : ''}`}
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

async function Archived() {
  const tasks = await listTasks({ archived: 'only', sort: 'updated' });
  return (
    <div className="space-y-2">
      <p className="text-sm md:text-xs text-muted-foreground px-1 md:px-0">Archived tasks are hidden everywhere else. Open one and press Restore to bring it back.</p>
      <TaskList tasks={tasks} empty="Nothing archived." />
    </div>
  );
}

async function Trash() {
  const [items, names] = await Promise.all([listTrash(), projectNameMap()]);
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
                      deleted {fmtAgo(t.deletedAt)} by {ACTOR_LABEL[t.deletedBy] ?? t.deletedBy}
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
