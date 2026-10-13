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

type Tab = 'completed' | 'activity' | 'archived' | 'trash';
type Props = { searchParams: Promise<{ tab?: string; actor?: string; weeks?: string }> };

export default async function HistoryPage({ searchParams }: Props) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === 'activity' || sp.tab === 'archived' || sp.tab === 'trash' ? sp.tab : 'completed';
  const weeks = Math.min(52, Math.max(1, Number(sp.weeks) || 8));

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">History</h1>
        <p className="text-sm text-muted-foreground mt-0.5">How work actually moved.</p>
      </div>
      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {(['completed', 'activity', 'archived', 'trash'] as Tab[]).map(t => (
          <Link
            key={t}
            href={`/history?tab=${t}`}
            className={cn(
              'px-3 py-1 rounded text-sm font-medium capitalize transition-colors',
              tab === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </Link>
        ))}
      </div>
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
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-xs text-muted-foreground mb-3">Completed per week</div>
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
      <Link href={`/history?tab=completed&weeks=${weeks + 8}`} className="text-xs underline text-muted-foreground">
        Show older
      </Link>
    </div>
  );
}

async function ActivityFeed({ actor }: { actor?: string }) {
  const a = actor === 'me' || actor === 'discord' || actor === 'claude' || actor === 'system' ? actor : undefined;
  const since = startOfDay(addDays(todayStr(), -14));
  const items = await listActivity({ since, actor: a, limit: 400 });
  const byDay = new Map<string, typeof items>();
  for (const i of items) {
    const d = dateInTz(new Date(i.at));
    byDay.set(d, [...(byDay.get(d) ?? []), i]);
  }
  return (
    <div className="space-y-5">
      <div className="flex gap-2 text-xs">
        {[undefined, 'me', 'discord', 'claude'].map(x => (
          <Link
            key={x ?? 'all'}
            href={`/history?tab=activity${x ? `&actor=${x}` : ''}`}
            className={cn('px-2 py-1 rounded border border-border', a === x ? 'bg-muted text-foreground' : 'text-muted-foreground')}
          >
            {x === 'me' ? 'By me (app)' : x === 'discord' ? 'By me (Discord)' : x === 'claude' ? 'By Claude' : 'Everyone'}
          </Link>
        ))}
        <span className="text-muted-foreground self-center">Last 14 days</span>
      </div>
      {[...byDay].map(([d, list]) => (
        <section key={d} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{format(parseISO(d), 'EEEE, MMM d')}</h2>
          <ActivityTimeline items={list} showTask />
        </section>
      ))}
      {!items.length && <p className="text-sm text-muted-foreground">No activity.</p>}
    </div>
  );
}

async function Archived() {
  const tasks = await listTasks({ archived: 'only', sort: 'updated' });
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Archived tasks are hidden everywhere else. Open one and press Restore to bring it back.</p>
      <TaskList tasks={tasks} empty="Nothing archived." />
    </div>
  );
}

async function Trash() {
  const [items, names] = await Promise.all([listTrash(), projectNameMap()]);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {`Deleted tasks stay here for ${TRASH_DAYS} days with their history, then they're gone for good.`}
      </p>
      {items.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {items.map(t => {
            const project = t.projectId ? names.get(t.projectId) : null;
            return (
              <li key={t.ref} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-sm text-foreground truncate">
                    <span className="font-mono text-muted-foreground">#{t.ref}</span> {t.title}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted-foreground">
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
                <div className="flex items-center gap-1 shrink-0">
                  <RestoreTrashButton taskRef={t.ref} />
                  <PurgeTrashButton taskRef={t.ref} title={t.title} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground py-2">{`Trash is empty. Deleted tasks show up here for ${TRASH_DAYS} days.`}</p>
      )}
    </div>
  );
}
