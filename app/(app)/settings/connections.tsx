import Link from '@/components/intent-link';
import { Bot, Laptop, Link2, Sparkles, type LucideIcon } from 'lucide-react';
import { NavIcon } from '@/components/nav-icons';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';
import type { Caller } from '@/lib/caller';
import { claudeConnection, isOnline } from '@/lib/get-started';
import { listDevices } from '@/lib/devices';
import { discordConfig, orgGuildId } from '@/lib/discord/client';
import { getProfile } from '@/lib/profile';
import { linkStatus } from '@/lib/delpat-os';
import { Dot, type Level } from './ui';
import { DelpatOsButton, DelpatOsNotice } from './delpat-os-link-buttons';

type Row = { id: string; icon: LucideIcon; name: string; detail: string; level: Level; status: string; action?: { href: string; label: string; primary: boolean }; control?: React.ReactNode; note?: React.ReactNode };

async function rows(caller: Caller): Promise<Row[]> {
  const [claude, devices, profile, guild, delpat] = await Promise.all([claudeConnection(caller), listDevices(caller).catch(() => []), getProfile(caller).catch(() => null), discordConfig() ? orgGuildId(caller.orgId).catch(() => null) : Promise.resolve(null), linkStatus(caller).catch(() => null)]);
  const online = devices.filter(d => isOnline(d.lastSeenAt));
  const out: Row[] = [];
  out.push(
    claude.done
      ? { id: 'claude', icon: Sparkles, name: 'Claude', detail: 'claude.ai and Claude Code can see and update your tasks.', level: 'ok', status: 'Connected', action: { href: '/claude?tab=setup', label: 'Manage', primary: false } }
      : claude.set
        ? { id: 'claude', icon: Sparkles, name: 'Claude', detail: 'Approved. Ask Claude about your tasks to finish.', level: 'warn', status: 'Not used yet', action: { href: '/claude?tab=setup', label: 'Finish', primary: true } }
        : { id: 'claude', icon: Sparkles, name: 'Claude', detail: 'So Claude can see and update your tasks.', level: 'off', status: 'Not connected', action: { href: '/claude?tab=setup', label: 'Connect', primary: true } },
  );
  if (claude.done && claude.lastUsedAt) out[0].detail = `Last used ${fmtAgo(claude.lastUsedAt)}.`;
  const linked = !!profile?.discordId;
  out.push(
    !discordConfig()
      ? { id: 'discord', icon: Bot, name: 'Discord', detail: 'The operator of this Work OS has not set Discord up.', level: 'off', status: 'Not available' }
      : !guild
        ? { id: 'discord', icon: Bot, name: 'Discord', detail: 'No Discord server is connected to this organization yet.', level: 'off', status: 'Not available' }
        : linked
          ? { id: 'discord', icon: Bot, name: 'Discord', detail: 'Commands on the server act as you; alerts come as messages.', level: 'ok', status: 'Linked', action: { href: '/settings?section=notifications#discord', label: 'Manage', primary: false } }
          : { id: 'discord', icon: Bot, name: 'Discord', detail: 'Link your account to use commands and get alerts on Discord.', level: 'off', status: 'Not linked', action: { href: '/settings?section=notifications#discord', label: 'Connect', primary: true } },
  );
  out.push(
    devices.length === 0
      ? { id: 'computers', icon: Laptop, name: 'Computers', detail: 'Let Claude work on your own PC.', level: 'off', status: 'None yet', action: { href: '/claude?tab=setup', label: 'Add a PC', primary: true } }
      : { id: 'computers', icon: Laptop, name: 'Computers', detail: devices.map(d => `${d.name} ${isOnline(d.lastSeenAt) ? 'online' : 'offline'}`).join(' · '), level: online.length ? 'ok' : 'warn', status: online.length ? `${online.length} online` : 'Offline', action: { href: '/claude?tab=setup', label: 'Manage', primary: false } },
  );
  // Delpat OS: only where this Work OS has a Delpat OS client set; each person links their own account (Link / Unlink here).
  if (delpat?.enabled) {
    out.push({
      id: 'delpat-os',
      icon: Link2,
      name: 'Delpat OS',
      detail: delpat.linked ? 'New project › From Delpat OS lists your projects there.' : 'Link your account to import your Delpat OS projects into Work OS.',
      level: delpat.linked ? 'ok' : 'off',
      status: delpat.linked ? 'Linked' : 'Not linked',
      control: <DelpatOsButton linked={delpat.linked} />,
      note: <DelpatOsNotice linked={delpat.linked} />,
    });
  }
  return out;
}

const btn = 'inline-flex items-center justify-center h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/** Connections as a plain table: what, its status, and one button. Claude is set up on Claude › Set up; Discord is linked in Notifications. */
export async function Connections({ caller }: { caller: Caller }) {
  const list = await rows(caller);
  return (
    <table data-connections className="w-full text-[15px]">
      <thead>
        <tr className={cn(ui.tableHead, 'text-left')}>
          <th scope="col" className="py-2 pr-3 font-medium">Connection</th>
          <th scope="col" className="hidden md:table-cell py-2 px-3 font-medium">Status</th>
          <th scope="col" className="py-2 pl-3 font-medium text-right"><span className="sr-only">Action</span></th>
        </tr>
      </thead>
      <tbody>
        {list.map(r => (
          <tr key={r.id} data-connection={r.id} className={cn(ui.tableRow, 'align-middle')}>
            <td className="py-2.5 pr-3 min-w-0">
              <div className="flex items-start gap-3 min-w-0">
                <NavIcon icon={r.icon} className="text-muted-foreground mt-0.5" />
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{r.name}</div>
                  <div className="flex md:hidden items-center gap-2 text-[13px] text-foreground/85" data-status-phone>
                    <Dot level={r.level} className="w-2 h-2" /> {r.status}
                  </div>
                  <div className="text-[13px] text-muted-foreground leading-snug" suppressHydrationWarning data-detail>{r.detail}</div>
                  {r.note}
                </div>
              </div>
            </td>
            <td className="hidden md:table-cell py-2.5 px-3 whitespace-nowrap" data-status>
              <span className="inline-flex items-center gap-2"><Dot level={r.level} className="w-2 h-2" /> {r.status}</span>
            </td>
            <td className="py-2.5 pl-3 text-right">
              {r.control}
              {r.action && (
                <Link href={r.action.href} data-connection-action={r.id} className={cn(btn, r.action.primary ? 'bg-foreground text-background hover:bg-foreground/90' : 'border border-border bg-card text-foreground hover:bg-muted/60')}>
                  {r.action.label}
                </Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
