'use client';

import Link from '@/components/intent-link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ChevronDown, ChevronsUpDown, Download, LogOut, Monitor, Moon, PanelLeft, Play, Plus, Search, Settings, Sparkles, Sun, type LucideIcon } from 'lucide-react';
import { logoutAction } from '@/app/actions';
import { placeOf, startClaudeUrl } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';
import { useApp } from './app-context';
import { NavIcon, PLACE_ICON } from './nav-icons';
import { PrivateBadge } from './private-badge';
import { RailTip } from './rail-tip';
import { QuickAddLauncher } from './quick-add';
import { openSearch } from './global-search';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSubmenu, MenuSubmenuTrigger, MenuTrigger } from './ui/menu';

const STATUS_DOT = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500' } as const;
const STATUS_TEXT = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;
const KEY = 'wos.sidebar'; // 'collapsed' | 'open'
const KEY_RECENT = 'wos.sidebar.recent'; // 'closed' | 'open'

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private window or blocked storage: the choice just is not remembered */
  }
};

type InstallEvent = Event & { prompt: () => Promise<void> };

export function Sidebar({ showSignOut = true }: { showSignOut?: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const place = placeOf(path);
  const { unread, badges, hasComputers, recent } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const toggleRef = useRef<() => void>(() => {});

  // The remembered choice is read after mount (the server render is always expanded).
  useEffect(() => {
    const t = setTimeout(() => {
      setCollapsed(read(KEY) === 'collapsed');
      setRecentOpen(read(KEY_RECENT) !== 'closed');
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const toggle = () => {
    setCollapsed(c => {
      write(KEY, c ? 'open' : 'collapsed');
      return !c;
    });
  };
  useEffect(() => {
    toggleRef.current = toggle;
  });

  // Ctrl/Cmd+B collapses or expands (not while typing: Ctrl+B is bold in notes); Ctrl/Cmd+, opens Settings.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (!window.matchMedia('(min-width: 768px)').matches) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        toggleRef.current();
      } else if (e.key === ',') {
        e.preventDefault();
        router.push('/settings');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const rail = collapsed;
  return (
    <aside
      data-sidebar
      data-collapsed={rail ? 'true' : 'false'}
      aria-label="Sidebar"
      className={cn('hidden md:flex shrink-0 h-[calc(100dvh-2.5rem)] sticky top-0 border-r bg-white dark:bg-black flex-col overflow-hidden transition-[width] duration-150', rail ? 'w-14' : 'w-[260px]')}
    >
      <div className={cn('flex items-center border-b border-border', rail ? 'flex-col gap-1 py-2' : 'gap-2 px-3 h-12')}>
        <div className={cn('flex items-center gap-2 min-w-0', !rail && 'flex-1')}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static icon */}
          <img src="/icons/192" alt="" width={24} height={24} className="w-6 h-6 rounded-md shrink-0" />
          {!rail && <span className="font-semibold text-[15px] tracking-tight text-foreground truncate">Work OS</span>}
        </div>
        <RailTip on={rail} label="Expand sidebar" hint="Ctrl+B">
          <button
            type="button"
            onClick={toggle}
            data-sidebar-toggle
            aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!rail}
            title={rail ? undefined : 'Collapse sidebar (Ctrl+B)'}
            className="w-9 h-9 grid place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <NavIcon icon={PanelLeft} />
          </button>
        </RailTip>
      </div>

      <div className="p-2 pb-1 space-y-0.5">
        <QuickAddLauncher
          render={open => (
            <RailTip on={rail} label="New task" hint="N">
              <button type="button" onClick={open} data-new-task aria-label={rail ? 'New task' : undefined} className={cn(ui.row, ui.rowPrimary, rail && 'justify-center px-0')}>
                <NavIcon icon={Plus} />
                {!rail && (
                  <>
                    New task
                    <kbd className="ml-auto text-[11px] font-mono text-background/70">N</kbd>
                  </>
                )}
              </button>
            </RailTip>
          )}
        />
        <RailTip on={rail} label="Search" hint="/">
          <button type="button" onClick={openSearch} data-search-button aria-label={rail ? 'Search' : undefined} className={cn(ui.row, ui.rowOff, rail && 'justify-center px-0')}>
            <NavIcon icon={Search} className="text-muted-foreground" />
            {!rail && (
              <>
                Search
                <kbd className={ui.kbd}>/</kbd>
              </>
            )}
          </button>
        </RailTip>
        {hasComputers ? (
          <RailTip on={rail} label="Start Claude" hint="S">
            <button type="button" onClick={() => router.push(startClaudeUrl())} data-start-claude-button aria-label={rail ? 'Start Claude' : undefined} className={cn(ui.row, ui.rowOff, rail && 'justify-center px-0')}>
              <NavIcon icon={Play} className="text-muted-foreground" />
              {!rail && (
                <>
                  Start Claude
                  <kbd className={ui.kbd}>S</kbd>
                </>
              )}
            </button>
          </RailTip>
        ) : (
          <RailTip on={rail} label="Set up Claude">
            <Link href="/claude?tab=setup" data-set-up-claude aria-label={rail ? 'Set up Claude' : undefined} className={cn(ui.row, ui.rowOff, rail && 'justify-center px-0')}>
              <NavIcon icon={Sparkles} className="text-muted-foreground" />
              {!rail && 'Set up Claude'}
            </Link>
          </RailTip>
        )}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-1" aria-label="Main">
        <Group>
          <NavItem rail={rail} href="/today" icon={PLACE_ICON.today} on={place === 'today'} count={badges.overdue} tone="red" keyHint="1">Today</NavItem>
          <NavItem rail={rail} href="/tasks" icon={PLACE_ICON.tasks} on={place === 'tasks'} keyHint="2">Tasks</NavItem>
          <NavItem rail={rail} href="/projects" icon={PLACE_ICON.projects} on={place === 'projects'} keyHint="3">Projects</NavItem>
          <NavItem rail={rail} href="/notes" icon={PLACE_ICON.notes} on={place === 'notes'} keyHint="4">Notes</NavItem>
          <NavItem rail={rail} href="/claude" icon={PLACE_ICON.claude} on={place === 'claude'} count={badges.claudeWaiting} tone="amber" keyHint="5">Claude</NavItem>
        </Group>
        <Group>
          <NavItem rail={rail} href="/notifications" icon={PLACE_ICON.inbox} on={place === 'inbox'} count={unread} tone="red">Inbox</NavItem>
          <NavItem rail={rail} href="/review" icon={PLACE_ICON.review} on={place === 'review'}>Review</NavItem>
          <NavItem rail={rail} href="/timetable" icon={PLACE_ICON.schedule} on={place === 'schedule'}>Schedule</NavItem>
        </Group>
        {!rail && recent.length > 0 && (
          <section className="pt-3" data-recent>
            <button
              type="button"
              onClick={() => {
                setRecentOpen(o => {
                  write(KEY_RECENT, o ? 'closed' : 'open');
                  return !o;
                });
              }}
              aria-expanded={recentOpen}
              className={cn(ui.sectionLabel, 'flex items-center gap-1.5 h-8 px-2.5 rounded-lg outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60')}
            >
              Recent
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', !recentOpen && '-rotate-90')} aria-hidden />
            </button>
            {recentOpen && (
              <ul className="space-y-0.5">
                {recent.map(p => {
                  const on = path === `/projects/${p.id}` || path.startsWith(`/projects/${p.id}/`);
                  return (
                    <li key={p.id}>
                      <Link href={`/projects/${encodeURIComponent(p.id)}`} data-recent-project={p.id} aria-current={on ? 'page' : undefined} className={cn(ui.row, on ? ui.rowOn : ui.rowOff)}>
                        <NavIcon icon={PLACE_ICON.projects} size={16} className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {p.private && <PrivateBadge compact className="text-muted-foreground" />}
                      </Link>
                    </li>
                  );
                })}
                <li>
                  <Link href="/projects" className={cn(ui.row, 'text-[13px] text-muted-foreground hover:text-foreground')}>
                    View all
                  </Link>
                </li>
              </ul>
            )}
          </section>
        )}
      </nav>

      <div className="p-2 border-t border-border shrink-0">
        <AccountMenu rail={rail} showSignOut={showSignOut} />
      </div>
    </aside>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="space-y-0.5 py-2 border-t border-border/60 first:border-t-0 first:pt-1">{children}</div>;
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function AccountMenu({ rail, showSignOut }: { rail: boolean; showSignOut: boolean }) {
  const router = useRouter();
  const { account, badges } = useApp();
  const { theme, setTheme } = useTheme();
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const signOut = useRef<HTMLFormElement>(null);

  // Chrome offers "install" once, early; keep it for the menu. Not offered when already installed.
  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    const on = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    const gone = () => setInstall(null);
    window.addEventListener('beforeinstallprompt', on);
    window.addEventListener('appinstalled', gone);
    return () => {
      window.removeEventListener('beforeinstallprompt', on);
      window.removeEventListener('appinstalled', gone);
    };
  }, []);

  const dot = account.operator ? STATUS_DOT[badges.status] : null;
  const themes: [string, string, LucideIcon][] = [
    ['light', 'Light', Sun],
    ['dark', 'Dark', Moon],
    ['system', 'System', Monitor],
  ];
  return (
    <>
      <Menu>
        <RailTip on={rail} label={account.name || 'Account'}>
          <MenuTrigger
            data-account-button
            aria-label={`Account menu, ${account.name}`}
            className={cn('flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left outline-none hover:bg-muted/60 data-popup-open:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60', rail && 'justify-center')}
          >
            <span className="relative shrink-0">
              <span className="grid place-items-center w-8 h-8 rounded-full bg-muted text-xs font-semibold text-foreground" aria-hidden>
                {initials(account.name || account.email)}
              </span>
              {dot && <span role="img" data-status-dot aria-label={STATUS_TEXT[badges.status]} title={STATUS_TEXT[badges.status]} className={cn('absolute -right-0.5 -top-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-black', dot)} />}
            </span>
            {!rail && (
              <>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium text-foreground">{account.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{account.org}</span>
                </span>
                <ChevronsUpDown className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />
              </>
            )}
          </MenuTrigger>
        </RailTip>
        <MenuContent side={rail ? 'right' : 'top'} align={rail ? 'end' : 'start'} testId="account" className="w-64">
          <MenuLabel>{account.email}</MenuLabel>
          <MenuItem icon={<NavIcon icon={Settings} className="text-muted-foreground" />} hint="Ctrl+," onClick={() => router.push('/settings')} data-menu-settings>
            Settings
          </MenuItem>
          <MenuSubmenu>
            <MenuSubmenuTrigger icon={<NavIcon icon={theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor} className="text-muted-foreground" />} data-menu-theme>
              Theme
            </MenuSubmenuTrigger>
            <MenuContent side="right" align="start" sideOffset={4} testId="theme" className="min-w-44">
              <MenuRadioGroup value={theme ?? 'system'} onValueChange={v => setTheme(String(v))}>
                {themes.map(([v, label, Icon]) => (
                  <MenuRadioItem key={v} value={v} icon={<NavIcon icon={Icon} className="text-muted-foreground" />} data-theme-option={v}>
                    {label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </MenuSubmenu>
          {install && (
            <MenuItem
              icon={<NavIcon icon={Download} className="text-muted-foreground" />}
              onClick={async () => {
                await install.prompt();
                setInstall(null);
              }}
              data-menu-install
            >
              Install app
            </MenuItem>
          )}
          {account.operator && (
            <>
              <MenuSeparator />
              <MenuItem icon={<span className={cn('w-2.5 h-2.5 mx-[3px] rounded-full', STATUS_DOT[badges.status])} aria-hidden />} onClick={() => router.push('/settings')} data-menu-status>
                Server: {STATUS_TEXT[badges.status]}
              </MenuItem>
            </>
          )}
          {showSignOut && (
            <>
              <MenuSeparator />
              <MenuItem icon={<NavIcon icon={LogOut} className="text-muted-foreground" />} onClick={() => signOut.current?.requestSubmit()} data-menu-sign-out>
                Sign out
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      <form ref={signOut} action={logoutAction} hidden />
    </>
  );
}

function NavItem({
  href,
  children,
  icon,
  on,
  count,
  tone,
  keyHint,
  rail,
}: {
  href: string;
  children: string;
  icon: LucideIcon;
  on?: boolean;
  count?: number;
  tone?: 'red' | 'amber';
  keyHint?: string;
  rail: boolean;
}) {
  const toneCls =
    tone === 'red'
      ? 'bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300'
      : tone === 'amber'
        ? 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  const dotCls = tone === 'amber' ? 'bg-amber-500' : 'bg-red-500';
  return (
    <RailTip on={rail} label={children} hint={keyHint}>
      <Link
        href={href}
        aria-current={on ? 'page' : undefined}
        aria-label={rail ? (count ? `${children}, ${count}` : children) : undefined}
        title={!rail && keyHint ? `${children} (${keyHint})` : undefined}
        className={cn('relative', ui.row, on ? ui.rowOn : ui.rowOff, rail && 'justify-center px-0')}
      >
        <NavIcon icon={icon} className="text-muted-foreground" />
        {!rail && children}
        {!rail && count ? <span className={cn(ui.badge, toneCls)}>{count}</span> : null}
        {rail && count ? <span data-badge-dot className={cn('absolute right-2 top-1.5 w-2 h-2 rounded-full', dotCls)} aria-hidden /> : null}
      </Link>
    </RailTip>
  );
}
