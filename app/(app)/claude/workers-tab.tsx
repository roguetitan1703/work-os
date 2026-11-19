import Link from '@/components/intent-link';
import { cn } from '@/lib/utils';
import { fmtAgo } from '@/lib/format';
import type { Roster, WorkerRow, WorkerState } from '@/lib/data/roster';
import { card, H2 } from './ui';

const STATE: Record<WorkerState, { text: string; cls: string }> = {
  working: { text: 'Working', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  waiting: { text: 'Waiting on a person', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  on: { text: 'On', cls: 'bg-muted text-muted-foreground' },
  idle: { text: 'Idle', cls: 'bg-muted text-muted-foreground' },
  off: { text: 'Off', cls: 'bg-red-500/10 text-red-700 dark:text-red-300' },
};

/** The roster (docs/flows/plan-1-3.md slice 7): who is working on what and where. Builders sit under their orchestrator. */
export function WorkersTab({ data, tz }: { data: Roster; tz: string }) {
  const { workers, couldBeRunning, machines } = data;
  return (
    <div className="space-y-5 md:max-w-4xl" data-section="workers">
      <CouldBeRunning list={couldBeRunning} />
      <section className="space-y-2">
        <h2 className={cn(H2, 'px-1 md:px-0 text-muted-foreground')}>Workers</h2>
        {workers.length === 0 ? (
          <p data-workers-empty className="px-1 md:px-0 text-[15px] md:text-sm text-muted-foreground">
            No one has reported in. A session that calls start_work on a project shows up here.
          </p>
        ) : (
          <ul className={cn(card, 'divide-y divide-border/60')} data-workers-list>
            {workers.map(w => (
              <Row key={w.id} w={w} tz={tz} />
            ))}
          </ul>
        )}
        {machines.length > 0 && (
          <p className="px-1 md:px-0 text-[13px] md:text-xs text-muted-foreground" data-heavy-slots>
            Heavy slots: {machines.map(m => `${m.machine} ${m.held} of ${m.cap}`).join(', ')}
          </p>
        )}
      </section>
    </div>
  );
}

/** Projects with unblocked Next work and no live worker. Also used on the project page. */
export function CouldBeRunning({ list, compact }: { list: Roster['couldBeRunning']; compact?: boolean }) {
  if (!list.length) return compact ? null : <p data-could-run-none className="px-1 md:px-0 text-[15px] md:text-sm text-muted-foreground">Every project with Next work has someone on it.</p>;
  return (
    <section className="space-y-2" data-could-run>
      <h2 className={cn(H2, 'px-1 md:px-0 text-amber-800 dark:text-amber-300')}>Could be running and isn&apos;t</h2>
      <ul className={cn(card, 'divide-y divide-border/60')}>
        {list.map(p => (
          <li key={p.projectId} className="px-4 md:px-3 py-2.5 md:py-2 min-h-11 text-[15px] md:text-sm" data-could-run-project={p.projectId}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/projects/${encodeURIComponent(p.projectId)}`} className="font-semibold text-foreground hover:underline">
                {p.projectName}
              </Link>
              <span className="text-muted-foreground text-[13px] md:text-xs">
                {`${p.unblocked} unblocked Next line${p.unblocked === 1 ? '' : 's'}, no one on it`}
              </span>
            </div>
            <div className="text-muted-foreground text-[13px] md:text-xs truncate">{p.first}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "since 14:02" for a session that stopped (idle) or waits: the hook's last event, in the person's timezone. */
function sinceText(iso: string, tz: string): string {
  try {
    return `since ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso))}`;
  } catch {
    return '';
  }
}

function Row({ w, tz }: { w: WorkerRow; tz: string }) {
  const st = STATE[w.state];
  const who = [w.ai, w.model].filter(Boolean).join(' · ');
  const where = [w.machine, w.branch].filter(Boolean).join(' · ');
  return (
    <li className={cn('px-4 md:px-3 py-2.5 md:py-2 min-h-11 space-y-0.5', w.depth === 1 && 'pl-8 md:pl-8 bg-muted/20')} data-worker={w.id} data-depth={w.depth} data-state={w.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[15px] md:text-sm font-semibold text-foreground" data-worker-person>
          {w.person}
        </span>
        <span className="text-[15px] md:text-sm text-foreground" data-worker-ai>
          {who}
        </span>
        {w.slot && <span className="text-[11px] px-1.5 py-px rounded bg-muted text-muted-foreground font-medium">slot {w.slot}</span>}
        <span className={cn('text-[11px] px-1.5 py-px rounded font-medium', st.cls)} data-worker-state>
          {w.state === 'waiting' && w.waitingOn === 'prompt' ? 'Waiting on you' : st.text}
          {w.state === 'idle' && w.nextWork > 0 ? ` · ${w.nextWork} Next line${w.nextWork === 1 ? '' : 's'} waiting` : ''}
        </span>
        {(w.state === 'idle' || w.state === 'waiting') && (
          <span className="text-[13px] md:text-xs text-muted-foreground" data-worker-since>
            {sinceText(w.since, tz)}
          </span>
        )}
        <span className="ml-auto text-[13px] md:text-xs text-muted-foreground" data-worker-seen>
          {fmtAgo(w.lastSeen)}
        </span>
      </div>
      <div className="text-[13px] md:text-xs text-muted-foreground">
        <Link href={`/projects/${encodeURIComponent(w.project.id)}`} className="hover:text-foreground hover:underline">
          {w.project.name}
        </Link>
        {where && <> · {where}</>}
        {w.account && <> · account {w.account}</>}
      </div>
      {w.doing && (
        <div className="text-[13px] md:text-xs" data-worker-doing>
          <span className="text-muted-foreground">Doing </span>
          <Link href={`/tasks/${w.doing.ref}`} className="text-foreground hover:underline">
            {`#${w.doing.ref} ${w.doing.title}`}
          </Link>
          {!w.doing.held && <span className="ml-2 px-1.5 py-px rounded bg-red-500/10 text-red-700 dark:text-red-300 font-medium" data-unheld>unheld</span>}
        </div>
      )}
    </li>
  );
}
