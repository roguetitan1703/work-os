import { CopyBox } from '@/components/copy-box';
import { ALERT_RULES, lastRunStatus } from '@/lib/alerts';
import { fmtAgo } from '@/lib/format';
import { Card, Disclosure, Section, StatusLine } from './ui';
import { requireScope } from '@/lib/caller';
import { getProfile } from '@/lib/profile';
import { TimeSettings } from './time-settings';

export async function AlertsSection({ base }: { base: string }) {
  const secret = process.env.CRON_SECRET;
  const ready = !!secret && secret.length >= 16;
  const scope = await requireScope();
  const [s, profile] = await Promise.all([lastRunStatus(scope), getProfile(scope)]);
  const stale = s.stale;
  const r = ALERT_RULES;

  return (
    <div className="space-y-5">
      <Section title="Your timezone and quiet hours">
        <Card>
          <TimeSettings timezone={profile.timezone} quietStart={profile.quietStart} quietEnd={profile.quietEnd} />
        </Card>
      </Section>

      <Section title="Scheduled checks">
        <Card>
          {!ready ? (
            <StatusLine level="off" title="Not set up">
              <p>Add CRON_SECRET in Vercel (16+ random characters), redeploy, then create the scheduled job in the setup guide below.</p>
            </StatusLine>
          ) : s.lastRunAt ? (
            <StatusLine level={stale ? 'warn' : 'ok'} title={`Last check ${fmtAgo(s.lastRunAt)}`}>
              <p suppressHydrationWarning>
                {s.lastResult}
                {stale ? ' (expected every 15 minutes; is the scheduled job running?)' : ''}
              </p>
              <p>
                Checks every 15 minutes.{' '}
                {profile.quietStart === profile.quietEnd ? 'No quiet hours.' : `Nothing is sent to you between ${profile.quietStart}:00 and ${profile.quietEnd}:00 (${profile.timezone}).`}
              </p>
            </StatusLine>
          ) : (
            <StatusLine level="warn" title="Ready · no scheduled check has run yet" />
          )}
        </Card>
      </Section>

      <Section title="Setup and rules">
        <div className="space-y-3">
          <Disclosure title="When alerts fire" hint="The six alert types">
      <ul className="text-sm text-foreground/90 space-y-1 list-disc pl-5">
        <li><b>Due tomorrow</b>: {r.dueTomorrowHour}:00 the day before, P1 and P2</li>
        <li><b>Due today</b>: {r.dueTodayHour}:00, everything due that day</li>
        <li><b>Overdue</b>: the morning after, then every {r.overdueEveryDays} days</li>
        <li><b>Stalled</b>: In Progress with no activity for {r.stalledWorkdays} workdays</li>
        <li><b>Never started</b>: P1 still Not Started {r.neverStartedHours}h after creation</li>
        <li><b>Unblocked</b>: right away when the last task it waited on is done</li>
      </ul>
          </Disclosure>
          <Disclosure title="Setup guide" hint="CRON_SECRET and the 15-minute job" open={!ready || !s.lastRunAt}>
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
        <li>If DMs fail with 403: in Discord, your organization&apos;s server → Privacy Settings → allow direct messages from server members.</li>
      </ol>
          </Disclosure>
        </div>
      </Section>
    </div>
  );
}
