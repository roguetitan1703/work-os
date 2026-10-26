import { CopyBox } from '@/components/copy-box';
import { ALERT_RULES, lastRunStatus } from '@/lib/alerts';
import { fmtAgo } from '@/lib/format';
import { Card, Disclosure, Section, StatusLine } from './ui';
import { requireScope } from '@/lib/caller';
import { getProfile } from '@/lib/profile';
import { TimeSettings } from './time-settings';

/** Settings › Notifications: your timezone and quiet hours. */
export async function QuietHours() {
  const scope = await requireScope();
  const profile = await getProfile(scope);
  return (
    <div data-quiet-hours>
      <TimeSettings timezone={profile.timezone} quietStart={profile.quietStart} quietEnd={profile.quietEnd} />
    </div>
  );
}

/** Settings › Server: the scheduled alert checks (status, rules, setup). Deployment business: the operator's. */
export async function ServerAlerts() {
  const secret = process.env.CRON_SECRET;
  const ready = !!secret && secret.length >= 16;
  const scope = await requireScope();
  const [s, profile] = await Promise.all([lastRunStatus(scope), getProfile(scope)]);
  const stale = s.stale;
  const r = ALERT_RULES;

  return (
    <div className="space-y-5">
      <Section title="Scheduled checks">
        <Card>
          {!ready ? (
            <StatusLine level="off" title="Not set up">
              <p>Add CRON_SECRET (16+ random characters) to /etc/work-os/env on the server and restart Work OS. The alerts timer then works on its own (see the setup guide below).</p>
            </StatusLine>
          ) : s.lastRunAt ? (
            <StatusLine level={stale ? 'warn' : 'ok'} title={`Last check ${fmtAgo(s.lastRunAt)}`}>
              <p suppressHydrationWarning>
                {s.lastResult}
                {stale ? ' (expected every 15 minutes; is work-os-alerts.timer running?)' : ''}
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
          <Disclosure title="Setup guide" hint="CRON_SECRET and the 15-minute timer" open={!ready || !s.lastRunAt}>
      <ol className="list-decimal pl-5 space-y-3 text-sm text-foreground/90">
        <li>On the server, add <code>CRON_SECRET</code> (any long random string) to <code>/etc/work-os/env</code> and restart <code>work-os</code>.</li>
        <li>
          The timer <code>work-os-alerts.timer</code> runs <code>work-os-cron-alerts</code> every 15 minutes. Check it:
          <CopyBox text="systemctl list-timers 'work-os*' && journalctl -u work-os-alerts -n 20" className="mt-2" />
        </li>
        <li>
          Preview without sending (from the server):
          <CopyBox text={`curl -H "Authorization: Bearer $CRON_SECRET" "http://127.0.0.1:3100/api/cron/alerts?dry=1"`} className="mt-2" />
        </li>
        <li>If DMs fail with 403: in Discord, your organization&apos;s server → Privacy Settings → allow direct messages from server members.</li>
      </ol>
          </Disclosure>
        </div>
      </Section>
    </div>
  );
}
