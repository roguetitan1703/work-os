import { BarChart3 } from 'lucide-react';
import { Disclosure } from '@/components/ui/disclosure';
import { EmptyState } from '@/components/ui/empty-state';
import { List, Row } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import { Tabs } from '@/components/ui/tabs';
import { ago } from '@/lib/data/lanes';
import { WEEKDAYS, type UsageReport, type UsageSlice } from '@/lib/data/claude-usage';
import { ORIGIN_LABEL, type SessionWhere } from '@/lib/session-item';
import { formatShare } from '@/lib/usage-format';
import { UsageResetForm } from './usage-reset-form';

const RANGES = [
  { key: 'week', label: 'This week' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'today', label: 'Today' },
];

const share = (x: number) => <span className="text-body tabular-nums text-foreground">{formatShare(x)}</span>;
const mix = (m: UsageSlice[]) => m.map(x => `${x.name} ${formatShare(x.share)}`).join(', ');
const dayLabel = (day: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(day + 'T12:00:00Z')).replace(',', '');

/** One section of rows with a share bar under each name; the bar is the share of the largest row. */
function Bars({ rows, days }: { rows: { key: string; name: string; share: number }[]; days?: boolean }) {
  const top = Math.max(0, ...rows.map(r => r.share));
  return (
    <List as="ul">
      {rows.map(r => (
        <Row
          key={r.key}
          as="li"
          title={days ? dayLabel(r.name) : r.name}
          meta={
            <span className="block h-1 rounded-pill bg-muted overflow-hidden mt-1" aria-hidden>
              <span className="block h-full rounded-pill bg-foreground/70" style={{ width: `${top ? (r.share / top) * 100 : 0}%` }} />
            </span>
          }
          trailing={share(r.share)}
        />
      ))}
    </List>
  );
}

/**
 * The Claude page's Usage tab: an estimate of which sessions, subagents, models, projects and days used the person's
 * Claude, from token counts their computers send (lib/data/claude-usage.ts). Never a share of the plan limit.
 * A day is a calendar date in the zone the computer reported it in (shown as that date, whatever the viewer's zone).
 */
export function UsageTab({ report }: { report: UsageReport }) {
  // eslint-disable-next-line react-hooks/purity -- a server render runs once per request
  const now = Date.now();
  const r = report;
  const empty = !r.hasAny ? (
    <EmptyState icon={<BarChart3 className="w-5 h-5" />} title="No usage yet" hint="Computers with the Work OS worker send it within 5 minutes." />
  ) : r.total === 0 ? (
    <EmptyState icon={<BarChart3 className="w-5 h-5" />} title="Nothing used in this range" />
  ) : null;
  return (
    <div className="space-y-5" data-section="usage">
      <div className="space-y-2">
        <Tabs label="Usage range" active={r.range} items={RANGES.map(x => ({ key: x.key, label: x.label, href: `/claude?tab=usage&range=${x.key}` }))} className="md:max-w-sm" />
        <p className="text-meta text-muted-foreground" data-usage-note>
          {r.label} · estimated from your computers&apos; session logs · not a share of your plan limit
          {r.updatedAt ? ` · updated ${ago(new Date(r.updatedAt), now)}` : ''}
        </p>
      </div>
      {empty}
      {!empty && (
        <>
          <Section label="Sessions" count={r.bySession.length}>
            <div className="space-y-2" data-usage-sessions>
              {r.bySession.map(x => {
                const where = x.origin === 'other' ? '' : ORIGIN_LABEL[x.origin as SessionWhere];
                const meta = [x.project?.name ?? 'No project', x.computer, where, mix(x.models), x.subagents.count > 0 ? `${x.subagents.count} subagent${x.subagents.count === 1 ? '' : 's'} (${formatShare(x.subagents.share)})` : ''].filter(Boolean).join(' · ');
                return (
                  <Disclosure
                    key={`${x.computer}|${x.sessionId}`}
                    data-usage-session={x.sessionId}
                    title={
                      <span className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate">{x.title}</span>
                        {share(x.share)}
                      </span>
                    }
                    hint={meta}
                  >
                    {x.subagents.count ? (
                      <ul className="space-y-2">
                        {x.subagents.items.map(sa => (
                          <li key={sa.id} className="flex items-center gap-3 min-w-0" data-usage-subagent={sa.id}>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body text-foreground">{sa.name}</span>
                              <span className="block truncate text-meta text-muted-foreground">{mix(sa.models)}</span>
                            </span>
                            {share(sa.share)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-meta text-muted-foreground">No subagents.</p>
                    )}
                  </Disclosure>
                );
              })}
            </div>
          </Section>
          <Section label="Projects" count={r.byProject.length}>
            <Bars rows={r.byProject} />
          </Section>
          <Section label="Models" count={r.byModel.length}>
            <Bars rows={r.byModel} />
          </Section>
          <Section label="Days" count={r.byDay.length}>
            <Bars rows={r.byDay.map(d => ({ key: d.day, name: d.day, share: d.share }))} days />
          </Section>
        </>
      )}
      <Disclosure title={`Week starts ${WEEKDAYS[r.reset.weekday]} ${r.reset.time} (${r.reset.tz})`} hint="The day of the reset counts whole." className="md:max-w-xl">
        <UsageResetForm weekday={r.reset.weekday} time={r.reset.time} tz={r.reset.tz} />
      </Disclosure>
    </div>
  );
}
