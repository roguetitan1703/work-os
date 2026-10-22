import Link from '@/components/intent-link';
import { usageReport, type UsageRange } from '@/lib/data/usage';
import { USAGE_CALLERS, USAGE_KINDS } from '@/lib/usage';
import { cn } from '@/lib/utils';
import { Card, Section } from './ui';

const KIND_LABEL: Record<string, string> = { page: 'Page load', rsc: 'Page data', action: 'Action', api: 'API' };
const CALLER_LABEL: Record<string, string> = { browser: 'Browser', worker: 'Worker', mcp: 'Claude (MCP)', cron: 'Cron', discord: 'Discord', anonymous: 'No sign-in' };
const fmt = (n: number) => n.toLocaleString('en-US');

/** Settings › Usage: the request log (lib/usage.ts, docs/usage-log.md). */
export async function UsageSection({ range }: { range?: string }) {
  const r = await usageReport();
  const week = range === '7d';
  const sel = week ? r.week : r.day;
  const maxHour = Math.max(1, ...r.hours.map(h => h.n));
  const maxDay = Math.max(1, ...r.days.map(d => d.n));

  return (
    <div className="space-y-5" data-usage>
      <Section title="Requests">
        <Card grouped>
          <div className="grid grid-cols-2 divide-x divide-border/60">
            <Stat label="Last 24 h" n={r.day.total} id="day" />
            <Stat label="Last 7 days" n={r.week.total} id="week" />
          </div>
          <Split title={`By kind · ${week ? 'last 7 days' : 'last 24 h'}`} keys={USAGE_KINDS} labels={KIND_LABEL} counts={sel.byKind} />
          <Split title={`By caller · ${week ? 'last 7 days' : 'last 24 h'}`} keys={USAGE_CALLERS} labels={CALLER_LABEL} counts={sel.byCaller} />
        </Card>
        <p className="px-1 mt-1.5 text-xs text-muted-foreground">
          Every page load, page-data fetch, action and API call that reaches the app. Static files (scripts, styles, images, icons, sw.js) come from
          Vercel&apos;s CDN and are not counted. Vercel&apos;s limit counts these plus static files.
        </p>
      </Section>

      <Section title="Per hour · last 24 h">
        <Card className="px-3 pt-4 pb-2">
          <div className="flex items-end gap-[2px] h-28" role="img" aria-label="Requests per hour, last 24 hours" data-usage-hours>
            {r.hours.map(h => (
              <div key={h.key} className="flex-1 min-w-0 h-full flex items-end" title={`${h.label}: ${fmt(h.n)}`}>
                <div className={cn('w-full rounded-t-sm', h.n ? 'bg-primary/70' : 'bg-muted')} style={{ height: `${h.n ? Math.max(4, (h.n / maxHour) * 100) : 2}%` }} />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground mt-1 tabular-nums">
            {[0, 6, 12, 18, 23].map(i => (
              <span key={i}>{r.hours[i].label}</span>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Per day · last 7 days">
        <Card className="px-4 py-3 space-y-1.5">
          {r.days.map(d => (
            <div key={d.date} className="flex items-center gap-3 text-[13px]" data-usage-day={d.date}>
              <span className="w-20 shrink-0 text-muted-foreground truncate">{d.label}</span>
              <span className="flex-1 min-w-0 h-3 rounded-sm bg-muted overflow-hidden">
                <span className="block h-full bg-primary/70" style={{ width: `${(d.n / maxDay) * 100}%` }} />
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{fmt(d.n)}</span>
            </div>
          ))}
        </Card>
        <p className="px-1 mt-1.5 text-xs text-muted-foreground">Days follow India time; the log keeps 35 days{r.since ? ` (oldest hour kept: ${r.since}:00 UTC)` : ''}.</p>
      </Section>

      <Section title="Top routes">
        <div className="flex gap-1 mb-2" role="tablist" aria-label="Range">
          {[
            { v: '24h', label: 'Last 24 h', on: !week },
            { v: '7d', label: 'Last 7 days', on: week },
          ].map(t => (
            <Link
              key={t.v}
              href={`/settings?section=usage${t.v === '7d' ? '&range=7d' : ''}`}
              prefetch={false}
              scroll={false}
              role="tab"
              aria-selected={t.on}
              data-usage-range={t.v}
              className={cn('h-9 px-3 inline-flex items-center rounded-lg text-sm font-medium', t.on ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60')}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <Routes range={sel} />
      </Section>

      <p className="px-1 text-xs text-muted-foreground">
        <b>Page load</b>: a full page from the address bar or a reload. <b>Page data</b>: what the app fetches when you tap a link, when a page
        refreshes itself, and when it loads pages ahead of time (Next.js does not let us tell these apart). <b>Action</b>: a button or form that
        saves something. <b>API</b>: Claude, the worker, cron, Discord and other /api calls.
      </p>
    </div>
  );
}

function Stat({ label, n, id }: { label: string; n: number; id: string }) {
  return (
    <div className="px-4 py-3 min-w-0">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" data-usage-total={id}>
        {fmt(n)}
      </div>
    </div>
  );
}

function Split({ title, keys, labels, counts }: { title: string; keys: string[]; labels: Record<string, string>; counts: Record<string, number> }) {
  const items = keys.filter(k => counts[k]);
  return (
    <div className="px-4 py-3 min-w-0">
      <div className="text-[13px] text-muted-foreground mb-1">{title}</div>
      {items.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          {items.map(k => (
            <span key={k}>
              {labels[k]} <b className="tabular-nums">{fmt(counts[k])}</b>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[14px] text-muted-foreground">Nothing yet</div>
      )}
    </div>
  );
}

function Routes({ range }: { range: UsageRange }) {
  const rows = range.routes.slice(0, 30);
  if (!rows.length) return <Card className="px-4 py-3 text-sm text-muted-foreground">No requests counted in this range yet.</Card>;
  return (
    <Card grouped>
      {rows.map(r => (
        <div key={r.route} className="px-4 py-2.5 min-w-0" data-usage-route={r.route}>
          <div className="flex items-baseline gap-3 min-w-0">
            <span className="flex-1 min-w-0 font-mono text-[13px] break-all">{r.route}</span>
            <span className="shrink-0 font-semibold tabular-nums">{fmt(r.total)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
            {r.parts.map(p => (
              <span key={`${p.kind}|${p.caller}`} data-usage-part={`${p.kind}|${p.caller}`}>
                {KIND_LABEL[p.kind] ?? p.kind} · {CALLER_LABEL[p.caller] ?? p.caller} <span className="tabular-nums text-foreground/80">{fmt(p.n)}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}
