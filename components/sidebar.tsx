'use client';

import Link from '@/components/intent-link';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, LogOut, Play, Search } from 'lucide-react';
import { logoutAction } from '@/app/actions';
import { placeOf, modeLinks, startClaudeUrl } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { useApp, useModes } from './app-context';
import { ThemeToggle } from './theme-toggle';
import { QuickAddLauncher } from './quick-add';
import { openSearch } from './global-search';

const STATUS_DOT = { ok: 'bg-green-500', warn: 'bg-amber-500', error: 'bg-red-500' } as const;
const STATUS_TEXT = { ok: 'All systems OK', warn: 'Needs a look', error: 'Problem' } as const;

export function Sidebar({ showSignOut = true }: { showSignOut?: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const place = placeOf(path);
  const { unread, badges } = useApp();
  return (
    <aside className="hidden md:flex w-56 shrink-0 h-[calc(100dvh-2.5rem)] sticky top-0 border-r bg-white dark:bg-black flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <span className="font-bold text-sm tracking-tight text-foreground">Work OS</span>
      </div>

      <div className="p-3 pb-2 space-y-1.5">
        <QuickAddLauncher />
        <button
          onClick={() => router.push(startClaudeUrl())}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border text-sm text-foreground hover:bg-muted transition-colors"
        >
          <Play className="w-3.5 h-3.5" />
          Start Claude
        </button>
        <button
          onClick={openSearch}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
          Search
          <kbd className="ml-auto text-[10px] font-mono border border-border rounded px-1">/</kbd>
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 text-sm" aria-label="Main">
        <Group>
          <NavItem href="/today" on={place === 'today'} count={badges.overdue} tone="red" keyHint="1">Today</NavItem>
          <NavItem href="/tasks" on={place === 'tasks'} keyHint="2">Tasks</NavItem>
          <NavItem href="/projects" on={place === 'projects'} keyHint="3">Projects</NavItem>
          <NavItem href="/notes" on={place === 'notes'} keyHint="4">Notes</NavItem>
          <NavItem href="/claude" on={place === 'claude'} count={badges.claudeWaiting} tone="amber" keyHint="5">Claude</NavItem>
        </Group>
        <Group>
          <NavItem href="/notifications" on={place === 'inbox'} count={unread} tone="red">Inbox</NavItem>
          <NavItem href="/review" on={place === 'review'}>Review</NavItem>
          <NavItem href="/timetable" on={place === 'schedule'}>Schedule</NavItem>
          <Modes />
        </Group>
      </nav>

      <div className="px-3 pt-2 pb-2 border-t border-border shrink-0 space-y-1">
        <NavItem href="/settings" on={place === 'settings'} dot={STATUS_DOT[badges.status]} dotLabel={STATUS_TEXT[badges.status]}>
          Settings
        </NavItem>
        <div className="flex items-center justify-between">
          <ThemeToggle />
          {showSignOut && (
            <form action={logoutAction}>
              <button type="submit" className="p-2 rounded-md text-muted-foreground hover:bg-muted" title="Sign out" aria-label="Sign out">
                <LogOut className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>
      </div>
    </aside>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="space-y-0.5 py-2 border-t border-border/60 first:border-t-0 first:pt-0">{children}</div>;
}

function Modes() {
  const path = usePathname();
  const params = useSearchParams();
  const active = params.get('mode');
  const { modes } = useModes();
  const [open, setOpen] = useState(false);
  const show = open || (!!active && path.startsWith('/tasks'));
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={show}
        className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted text-foreground/80 transition-colors w-full"
      >
        Modes
        <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', show && 'rotate-90')} />
      </button>
      {show &&
        modeLinks(modes).map(m => (
          <Link
            key={m.name}
            href={m.href}
            className={cn('flex items-center gap-2 pl-4 pr-2 py-1.5 rounded hover:bg-muted text-foreground/80 transition-colors', active === m.name && path.startsWith('/tasks') && 'bg-muted font-medium text-foreground')}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.hex }} />
            <span className="truncate">{m.name}</span>
          </Link>
        ))}
    </div>
  );
}

function NavItem({
  href,
  children,
  on,
  count,
  tone,
  dot,
  dotLabel,
  keyHint,
}: {
  href: string;
  children: React.ReactNode;
  on?: boolean;
  count?: number;
  tone?: 'red' | 'amber';
  dot?: string;
  dotLabel?: string;
  keyHint?: string;
}) {
  const toneCls =
    tone === 'red'
      ? 'bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300'
      : tone === 'amber'
        ? 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return (
    <Link
      href={href}
      aria-current={on ? 'page' : undefined}
      title={keyHint ? `${children} (${keyHint})` : undefined}
      className={cn('flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted transition-colors w-full', on ? 'bg-muted text-foreground font-medium' : 'text-foreground/80')}
    >
      {children}
      {count ? <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${toneCls}`}>{count}</span> : null}
      {dot ? <span role="img" aria-label={dotLabel} title={dotLabel} className={cn('w-2 h-2 rounded-full', dot)} /> : null}
    </Link>
  );
}
