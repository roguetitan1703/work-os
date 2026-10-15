import 'server-only';
import { lastRunStatus } from '@/lib/alerts';
import { mailConfigured } from '@/lib/mail';
import { pushConfigured, pushDeviceCount } from '@/lib/notify';
import { systemStatusLevel } from '@/lib/data/nav-counts';
import { cn } from '@/lib/utils';
import { Dot, type Level } from './ui';

const TITLE = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;
const TEXT = { ok: 'text-green-700 dark:text-green-300', warn: 'text-amber-700 dark:text-amber-300', error: 'text-red-700 dark:text-red-300' } as const;

/** One strip at the top of Settings: overall level (same helper as the sidebar dot) and what each part is doing. */
export async function StatusStrip() {
  const [base, devices, run] = await Promise.all([
    systemStatusLevel().catch(() => 'warn' as const),
    pushDeviceCount().catch(() => 0),
    lastRunStatus().catch(() => null),
  ]);
  const cron = process.env.CRON_SECRET;
  const parts: { label: string; level: Level; text: string }[] = [
    !pushConfigured()
      ? { label: 'Push', level: 'warn', text: 'Push not set up' }
      : devices > 0
        ? { label: 'Push', level: 'ok', text: `Push on · ${devices} device${devices === 1 ? '' : 's'}` }
        : { label: 'Push', level: 'off', text: 'Push off on every device' },
    !cron || cron.length < 16
      ? { label: 'Alerts', level: 'warn', text: 'Alerts not set up' }
      : !run?.lastRunAt
        ? { label: 'Alerts', level: 'warn', text: 'Alerts: no check has run yet' }
        : run.stale
          ? { label: 'Alerts', level: 'warn', text: 'Alerts: checks look stopped' }
          : { label: 'Alerts', level: 'ok', text: 'Alerts running' },
    mailConfigured() ? { label: 'Email', level: 'ok', text: 'Email on' } : { label: 'Email', level: 'off', text: 'Email reset not set up' },
  ];
  const level = base === 'ok' && parts.some(p => p.level === 'warn' || p.level === 'error') ? 'warn' : base;
  return (
    <div role="status" data-settings-status={level} className="rounded-2xl bg-card border border-border/70 px-4 py-3 min-h-14">
      <div className="flex items-center gap-3">
        <Dot level={level} />
        <span className={cn('text-[15px] font-semibold', TEXT[level])}>{TITLE[level]}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        {parts.map(p => (
          <li key={p.label} className="flex items-center gap-1.5">
            <Dot level={p.level} className="w-2 h-2" />
            {p.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
