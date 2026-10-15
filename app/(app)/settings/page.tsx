import Link from 'next/link';
import { ChevronRight, LogOut } from 'lucide-react';
import { SubHeader } from '@/components/mobile/sub-header';
import { logoutAction } from '@/app/actions';
import { uiAuthDisabled } from '@/lib/auth';
import { discordConfig } from '@/lib/discord/client';
import { listPasskeys } from '@/lib/passkeys';
import { NOTIFY_KINDS, getNotifySettings, pushConfigured, pushDeviceCount, vapidPublicKey } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { AlertsSection } from './alerts-section';
import { baseUrl } from './base-url';
import { Connections } from './connections';
import { AlertsTable, InstallCard, PushCard, Row, ThemeChoice } from './device-settings';
import { Help } from './help';
import { SecuritySettings } from './security-settings';
import { StatusStrip } from './status-strip';

export const metadata = { title: 'Settings · Work OS' };

const SECTIONS = [
  { id: 'device', label: 'This device' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'security', label: 'Security' },
  { id: 'connections', label: 'Connections' },
  { id: 'help', label: 'Help and recovery' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];
const sectionFrom = (v: string | undefined): SectionId | null => SECTIONS.find(s => s.id === v)?.id ?? null;

type Props = { searchParams: Promise<{ section?: string; open?: string }> };

/**
 * One Settings. The section lives in `?section=`. Phone (<768px): no section shows the overview (status, This device, a row per
 * section); a section shows only itself under a Back to Settings header. Desktop: left sub-nav and one section at a time
 * (default This device). Only the active section is rendered; CSS switches the status strip, sub-nav and phone rows.
 */
export default async function SettingsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const sec = sectionFrom(sp.section);
  const active: SectionId = sec ?? 'device';
  const title = sec ? SECTIONS.find(s => s.id === sec)!.label : 'Settings';
  const body: Record<SectionId, () => React.ReactNode> = {
    device: () => <DeviceSection />,
    alerts: () => <AlertsPanel />,
    security: () => (
      <Group title="Security" note="Passkeys sign you in without a password. The authenticator app adds a code step to password sign-in." first>
        <SecuritySettings />
      </Group>
    ),
    connections: () => <Connections open={sp.open} />,
    help: () => <Help />,
  };

  return (
    <div className="max-w-4xl mx-auto pb-6">
      {sec ? <SubHeader title={title} back="/settings" backLabel="Settings" /> : <SubHeader title="Settings" />}
      <h1 className="hidden md:block text-2xl font-bold mb-3">Settings</h1>

      <div className={cn(sec && 'hidden md:block')}>
        <StatusStrip />
      </div>

      <div className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-8 md:mt-5">
        <nav aria-label="Settings sections" className="hidden md:block">
          <ul className="sticky top-4 space-y-1">
            {SECTIONS.map(s => (
              <li key={s.id}>
                <Link
                  href={`/settings?section=${s.id}`}
                  prefetch
                  scroll={false}
                  aria-current={s.id === active ? 'page' : undefined}
                  data-section={s.id}
                  className={cn(
                    'flex items-center h-10 px-3 rounded-lg text-sm font-medium',
                    s.id === active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 max-w-xl">
          {body[active]()}
          {!sec && <PhoneRows />}
        </div>
      </div>
    </div>
  );
}

async function DeviceSection() {
  const devices = await pushDeviceCount().catch(() => 0);
  return (
    <Group title="This device" first>
      <InstallCard />
      <PushCard vapidKey={vapidPublicKey()} devices={devices} />
      <Row title="Theme" sub="Light, dark, or follow the device." action={<ThemeChoice />} />
      {!uiAuthDisabled() && (
        <form action={logoutAction}>
          <button type="submit" className="w-full flex items-center gap-3 px-4 h-14 text-[15px] text-red-600 dark:text-red-400 active:bg-muted/60">
            <LogOut className="w-5 h-5" /> Sign out
          </button>
        </form>
      )}
    </Group>
  );
}

async function AlertsPanel() {
  const [prefs, devices, base] = await Promise.all([getNotifySettings(), pushDeviceCount().catch(() => 0), baseUrl()]);
  return (
    <div className="space-y-5">
      <Group title="Alerts" note="Quiet hours 23:00–08:00 IST: nothing is sent; it waits for the morning." first>
        <AlertsTable initial={prefs} kinds={NOTIFY_KINDS} discordReady={!!discordConfig()} pushReady={pushConfigured()} devices={devices} />
      </Group>
      <AlertsSection base={base} />
    </div>
  );
}

/** Phone overview rows, one per section after This device. */
async function PhoneRows() {
  const [prefs, passkeys] = await Promise.all([getNotifySettings(), listPasskeys().catch(() => null)]);
  const token = process.env.MCP_TOKEN;
  const on = NOTIFY_KINDS.filter(k => prefs.kinds[k.kind]).length;
  const rows = [
    { id: 'alerts', label: 'Alerts', hint: `${on} of ${NOTIFY_KINDS.length} on` },
    { id: 'security', label: 'Security', hint: passkeys ? `Passkeys ${passkeys.length}` : '' },
    { id: 'connections', label: 'Connections', hint: `Chat ${token && token.length >= 24 ? '✓' : '✗'} · Discord ${discordConfig() ? '✓' : '✗'}` },
    { id: 'help', label: 'Help and recovery', hint: '' },
  ];
  return (
    <section className="mt-5 md:hidden">
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
        {rows.map(r => (
          <Link key={r.id} href={`/settings?section=${r.id}`} prefetch data-row={r.id} className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
            <span className="flex-1 min-w-0 truncate text-[16px] text-foreground">{r.label}</span>
            {r.hint && <span className="text-sm text-muted-foreground truncate">{r.hint}</span>}
            <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function Group({ title, note, first, children }: { title: string; note?: string; first?: boolean; children: React.ReactNode }) {
  return (
    <section className={first ? 'mt-5 md:mt-0' : 'mt-5'}>
      <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">{children}</div>
      {note && <p className="px-1 mt-1.5 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
