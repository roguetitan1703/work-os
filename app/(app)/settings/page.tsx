import Link from 'next/link';
import { Activity, ChevronRight, LogOut, Plug } from 'lucide-react';
import { SubHeader } from '@/components/mobile/sub-header';
import { ThemeToggle } from '@/components/theme-toggle';
import { logoutAction } from '@/app/actions';
import { uiAuthDisabled } from '@/lib/auth';
import { discordConfig } from '@/lib/discord/client';
import { NOTIFY_KINDS, getNotifySettings, pushDeviceCount, vapidPublicKey } from '@/lib/notify';
import { InstallCard, NotifyPrefs, PushCard } from './device-settings';
import { SecuritySettings } from './security-settings';

export const metadata = { title: 'Settings · Work OS' };

export default async function SettingsPage() {
  const [prefs, devices] = await Promise.all([getNotifySettings(), pushDeviceCount()]);
  return (
    <div className="max-w-xl mx-auto pb-6">
      <SubHeader title="Settings" />
      <h1 className="hidden md:block text-2xl font-bold mb-2">Settings</h1>

      <Group title="This device">
        <InstallCard />
        <PushCard vapidKey={vapidPublicKey()} devices={devices} />
      </Group>

      <Group title="Notifications" note="Quiet hours 23:00–08:00 IST: nothing is sent; it waits for the morning.">
        <NotifyPrefs initial={prefs} kinds={NOTIFY_KINDS} discordReady={!!discordConfig()} />
      </Group>

      <Group title="Security" note="Passkeys sign you in without a password. The authenticator app adds a code step to password sign-in.">
        <SecuritySettings />
      </Group>

      <Group title="App">
        <div className="flex items-center justify-between px-4 h-14">
          <span className="text-[15px]">Appearance</span>
          <ThemeToggle />
        </div>
        <Link href="/connect" className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
          <Activity className="w-5 h-5 text-green-600" />
          <span className="flex-1 text-[15px]">System status</span>
          <span className="text-sm text-muted-foreground">Connect</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
        </Link>
        <Link href="/connect" className="flex items-center gap-3 px-4 h-14 active:bg-muted/60">
          <Plug className="w-5 h-5 text-orange-500" />
          <span className="flex-1 text-[15px]">Claude, Discord &amp; alerts setup</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground/40" />
        </Link>
        {!uiAuthDisabled() && (
          <form action={logoutAction}>
            <button type="submit" className="w-full flex items-center gap-3 px-4 h-14 text-[15px] text-red-600 dark:text-red-400 active:bg-muted/60">
              <LogOut className="w-5 h-5" /> Sign out
            </button>
          </form>
        )}
      </Group>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="px-1 mb-1.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">{children}</div>
      {note && <p className="px-1 mt-1.5 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
