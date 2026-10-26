import Link from '@/components/intent-link';
import { redirect } from 'next/navigation';
import { ChevronRight, LogOut } from 'lucide-react';
import { NavIcon } from '@/components/nav-icons';
import { SubHeader } from '@/components/mobile/sub-header';
import { logoutAction } from '@/app/actions';
import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth-server';
import { requireCaller, type Caller } from '@/lib/caller';
import { isOperator } from '@/lib/operator';
import { inviteLinkToInviter, listMembers } from '@/lib/members';
import { mailConfigured, missingMailEnv } from '@/lib/mail';
import { discordConfig } from '@/lib/discord/client';
import { NOTIFY_KINDS, getNotifySettings, pushConfigured, pushDeviceCount, vapidPublicKey } from '@/lib/notify';
import { systemStatusLevel } from '@/lib/data/nav-counts';
import { claudeConnection, getChecklist } from '@/lib/get-started';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';
import { ChecklistCard } from '../today/checklist-card';
import { QuietHours, ServerAlerts } from './alerts-section';
import { baseUrl } from './base-url';
import { Connections } from './connections';
import { AlertsTable, InstallCard, PushCard, Row, ThemeChoice } from './device-settings';
import { DiscordLinkPanel } from './discord-link-panel';
import { DiscordSection } from './discord-section';
import { Help } from './help';
import { MembersSection } from './members-section';
import { MigrationNotice } from './migration-notice';
import { SECTION_ICON } from './section-icons';
import { LEGACY, SECTIONS, sectionIn, type SectionDef, type SectionId } from './sections';
import { SecuritySettings } from './security-settings';
import { SettingsNav } from './settings-nav';
import { StatusStrip } from './status-strip';
import { UsageSection } from './usage-section';

export const metadata = { title: 'Settings · Work OS' };

type Props = { searchParams: Promise<{ section?: string; open?: string; range?: string }> };

/** Who sees Server: the operator (everything on it), and an owner or admin (the Discord channels they already manage). */
function canSeeServer(c: Caller) {
  return isOperator(c) || c.role === 'owner' || c.role === 'admin';
}

/**
 * One Settings, laid out like the Claude app's: a left list (search, groups You / Team / Server, the open section as a
 * soft pill) and the section on the right under a 24px title with its main action. The section lives in `?section=`;
 * the old names (device, alerts, security, members, usage, help) redirect to where they went. Phone (<768px): no section
 * shows a list of rows with a plain line each; a section shows only itself under a Back header.
 * Server-side checks are unchanged: every action re-checks the caller; this page only decides what to draw.
 */
export default async function SettingsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const caller = await requireCaller();
  const operator = isOperator(caller);
  // Old links into Connections: the Discord card is now in Notifications, the Claude connector guide in Claude › Set up.
  if (sp.section === 'connections' && sp.open === 'discord') redirect('/settings?section=notifications&open=discord');
  if (sp.section === 'connections' && (sp.open === 'chat' || sp.open === 'code')) redirect('/claude?tab=setup');
  const legacy = sp.section ? (Object.hasOwn(LEGACY, sp.section) ? LEGACY[sp.section] : undefined) : undefined;
  if (legacy) {
    const open = legacy.open ?? sp.open;
    redirect(`/settings?section=${legacy.to}${open ? `&open=${encodeURIComponent(open)}` : ''}${sp.range ? `&range=${encodeURIComponent(sp.range)}` : ''}`);
  }

  const sections = SECTIONS.filter(s => s.id !== 'server' || canSeeServer(caller));
  const asked = sectionIn(sp.section);
  const sec = asked && sections.some(s => s.id === asked) ? asked : null;
  const active: SectionId = sec ?? 'account';
  const def = SECTIONS.find(s => s.id === active)!;
  // The "needs a look" dot is the operator's, on Server only (members cannot fix server health).
  const level = operator ? await systemStatusLevel(caller).catch(() => 'ok' as const) : 'ok';
  const dot = operator && level !== 'ok' ? ('server' as const) : null;

  const body: Record<SectionId, () => React.ReactNode> = {
    account: () => <AccountPanel caller={caller} />,
    notifications: () => <NotificationsPanel caller={caller} />,
    connections: () => <Connections caller={caller} />,
    started: () => <StartedPanel caller={caller} />,
    team: () => <TeamPanel caller={caller} open={sp.open} />,
    server: () => <ServerPanel caller={caller} range={sp.range} />,
  };
  const action: Partial<Record<SectionId, React.ReactNode>> = {
    account: (
      <form action={logoutAction}>
        <button type="submit" data-sign-out className={cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60')}>
          <LogOut size={16} strokeWidth={1.6} aria-hidden /> Sign out
        </button>
      </form>
    ),
    connections: (
      <Link href="/claude?tab=setup" className={cn(btn, 'bg-foreground text-background hover:bg-foreground/90')} data-title-action>
        Set up Claude
      </Link>
    ),
    team:
      caller.role === 'owner' || caller.role === 'admin' ? (
        <Link href="/settings?section=team#invite" className={cn(btn, 'bg-foreground text-background hover:bg-foreground/90')} data-title-action>
          Invite
        </Link>
      ) : undefined,
  };

  return (
    <div className="max-w-5xl mx-auto pb-6" data-settings>
      {sec ? <SubHeader title={def.label} back="/settings" backLabel="Settings" /> : <SubHeader title="Settings" />}
      <MigrationNotice />

      <div className="md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:gap-10 md:mt-2">
        <SettingsNav items={sections} active={active} dot={dot} />

        <div className="min-w-0 max-w-2xl">
          {/* The 24px title row. On the phone the Back header already carries the title; only the action stays. */}
          <div className={cn('flex items-center justify-between gap-3 min-h-9 mb-4', !action[active] && 'max-md:hidden', !sec && 'max-md:hidden')} data-title-row>
            <h1 className={cn(ui.pageTitle, 'hidden md:block')}>{def.label}</h1>
            <div className="ml-auto">{action[active]}</div>
          </div>
          <div className={cn(!sec && 'max-md:hidden')}>{body[active]()}</div>
          {!sec && <PhoneRows caller={caller} sections={sections} operator={operator} level={level} />}
        </div>
      </div>
    </div>
  );
}

const btn = 'inline-flex items-center justify-center gap-1.5 h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

async function AccountPanel({ caller }: { caller: Caller }) {
  const session = await (await getAuth()).api.getSession({ headers: await headers() }).catch(() => null);
  const twoFactor = !!(session?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled;
  return (
    <div className="space-y-5">
      <Group title="Appearance">
        <Row title="Theme" sub="Light, dark, or follow the device." action={<ThemeChoice />} />
      </Group>
      <Group title="Security" note="Passkeys sign you in without a password. The authenticator app adds a code step to password sign-in.">
        <SecuritySettings email={caller.email} twoFactor={twoFactor} mail={{ configured: mailConfigured(), missing: missingMailEnv(), to: caller.email }} />
      </Group>
    </div>
  );
}

/** One page for everything that reaches you: this phone, what you are told about, quiet hours, the Discord link. */
async function NotificationsPanel({ caller }: { caller: Caller }) {
  const [prefs, devices] = await Promise.all([getNotifySettings(caller), pushDeviceCount(caller).catch(() => 0)]);
  return (
    <div className="space-y-5">
      <Group title="This device">
        <InstallCard />
        <PushCard vapidKey={vapidPublicKey()} devices={devices} />
      </Group>
      <Group title="What to be told about" note="During your quiet hours nothing is sent; it waits until they end.">
        <AlertsTable initial={prefs} kinds={NOTIFY_KINDS} discordReady={!!discordConfig()} pushReady={pushConfigured()} devices={devices} />
      </Group>
      <Group title="Quiet hours and time zone">
        <QuietHours />
      </Group>
      <div id="discord" className="scroll-mt-6" data-notifications-discord>
        <Group title="Discord">
          <DiscordLinkPanel caller={caller} />
        </Group>
      </div>
    </div>
  );
}

async function StartedPanel({ caller }: { caller: Caller }) {
  const list = await getChecklist(caller);
  return <ChecklistCard list={list} where="settings" />;
}

async function TeamPanel({ caller, open }: { caller: Caller; open?: string }) {
  const { members, invitations } = await listMembers(caller);
  return (
    <div className="space-y-8">
      <MembersSection members={members} invitations={invitations} canInvite={caller.role === 'owner' || caller.role === 'admin'} isOwner={caller.role === 'owner'} linkToInviter={inviteLinkToInviter()} />
      <div id="modes" className="scroll-mt-6">
        <Help open={open === 'modes'} />
      </div>
    </div>
  );
}

async function ServerPanel({ caller, range }: { caller: Caller; range?: string }) {
  const operator = isOperator(caller);
  const base = await baseUrl();
  return (
    <div className="space-y-8" data-server>
      {operator && <StatusStrip />}
      <div className="space-y-3">
        <h2 className={cn(ui.sectionLabel, 'px-1')}>Discord</h2>
        <DiscordSection base={base} caller={caller} />
      </div>
      {operator && (
        <div className="space-y-3">
          <h2 className={cn(ui.sectionLabel, 'px-1')}>Scheduled alert checks</h2>
          <ServerAlerts />
        </div>
      )}
      {operator && (
        <div className="space-y-3">
          <h2 className={cn(ui.sectionLabel, 'px-1')}>Usage</h2>
          <UsageSection range={range} />
        </div>
      )}
    </div>
  );
}

/** Phone list: a plain line per section (what is on, not the setting itself), grouped like the desktop list. */
async function PhoneRows({ caller, sections, operator, level }: { caller: Caller; sections: SectionDef[]; operator: boolean; level: 'ok' | 'warn' | 'error' }) {
  const [devices, claude, list, members] = await Promise.all([
    pushDeviceCount(caller).catch(() => 0),
    claudeConnection(caller).catch(() => null),
    getChecklist(caller).catch(() => null),
    listMembers(caller).catch(() => null),
  ]);
  const hint: Record<SectionId, string> = {
    account: 'Theme, password, sign out',
    notifications: devices > 0 ? 'Alerts on your phone: on' : 'Alerts on your phone: off',
    connections: claude?.done ? 'Claude: connected' : 'Claude: not connected',
    started: list ? `${list.done} of ${list.total} done` : '',
    team: members ? `${members.members.length} ${members.members.length === 1 ? 'person' : 'people'}` : '',
    server: operator ? (level === 'ok' ? 'Running fine' : 'Needs a look') : 'Discord channels',
  };
  const groups = ['You', 'Team', 'Server'] as const;
  return (
    <div className="md:hidden space-y-5 mt-1" data-settings-rows>
      {groups.map(g => {
        const rows = sections.filter(s => s.group === g);
        if (!rows.length) return null;
        return (
          <section key={g}>
            <h2 className={cn(ui.sectionLabel, 'px-1 mb-1.5')}>{g}</h2>
            <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
              {rows.map(r => (
                <Link key={r.id} href={`/settings?section=${r.id}`} data-row={r.id} className="flex items-center gap-3 px-4 min-h-14 py-2 active:bg-muted/60">
                  <NavIcon icon={SECTION_ICON[r.id]} className="text-muted-foreground" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[16px] text-foreground">{r.label}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">{hint[r.id]}</span>
                  </span>
                  {r.id === 'server' && operator && level !== 'ok' && <span role="img" aria-label="Needs a look" data-settings-dot className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className={cn(ui.sectionLabel, 'px-1 mb-1.5')}>{title}</h2>
      <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">{children}</div>
      {note && <p className="px-1 mt-1.5 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
