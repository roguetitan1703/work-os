import { CopyBox } from '@/components/copy-box';
import { ALERT_RULES, lastRunStatus } from '@/lib/alerts';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export async function AlertsSection({ base }: { base: string }) {
  const secret = process.env.CRON_SECRET;
  const ready = !!secret && secret.length >= 16;
  const s = await lastRunStatus();
  const stale = s.stale;
  const r = ALERT_RULES;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Alerts (Discord DMs)</h2>
        <p className="text-sm text-muted-foreground">The bot DMs you when work slips. One batched message per check; nothing between {r.quietStart}:00 and {r.quietEnd}:00.</p>
      </div>
      <div className={cn('rounded-lg border px-4 py-3 text-sm', ready && !stale ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/5')}>
        {!ready ? (
          <span className="text-amber-700 dark:text-amber-300">Not set up: add CRON_SECRET in Vercel (16+ random characters), redeploy, then create the scheduled job below.</span>
        ) : s.lastRunAt ? (
          <span suppressHydrationWarning className={stale ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300'}>
            Last check {fmtAgo(s.lastRunAt)}: {s.lastResult}
            {stale ? ' (expected every 15 minutes; is the scheduled job running?)' : ''}
          </span>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">Ready, but no scheduled check has run yet.</span>
        )}
      </div>
      <ul className="text-sm text-foreground/90 space-y-1 list-disc pl-5">
        <li><b>Due tomorrow</b>: {r.dueTomorrowHour}:00 the day before, P1 and P2</li>
        <li><b>Due today</b>: {r.dueTodayHour}:00, everything due that day</li>
        <li><b>Overdue</b>: the morning after, then every {r.overdueEveryDays} days</li>
        <li><b>Stalled</b>: In Progress with no activity for {r.stalledWorkdays} workdays</li>
        <li><b>Never started</b>: P1 still Not Started {r.neverStartedHours}h after creation</li>
        <li><b>Unblocked</b>: right away when the last task it waited on is done</li>
      </ul>
      <ol className="list-decimal pl-5 space-y-3 text-sm text-foreground/90">
        <li>In Vercel add <code>CRON_SECRET</code> (any long random string) and redeploy.</li>
        <li>
          On <b>cron-job.org</b> (free) create a job: URL below, every 15 minutes, and under <i>Advanced → Headers</i> add <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code>.
          <CopyBox text={`${base}/api/cron/alerts`} className="mt-2" />
        </li>
        <li>
          Preview without sending:
          <CopyBox text={`curl -H "Authorization: Bearer $CRON_SECRET" "${base}/api/cron/alerts?dry=1"`} className="mt-2" />
        </li>
        <li>If DMs fail with 403: in Discord, Delpat server → Privacy Settings → allow direct messages from server members.</li>
      </ol>
    </section>
  );
}
