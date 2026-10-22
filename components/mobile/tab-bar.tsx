'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CalendarCheck, FolderOpen, LayoutList, Menu, Plus, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { phoneTabOf } from '@/lib/nav';
import { useApp } from '../app-context';
import { QuickAddSheet } from './quick-add-sheet';
import { BellButton } from './bell';
import { openSearch } from '../global-search';

type TabKey = 'today' | 'projects' | 'claude' | 'tasks';
const TABS: ({ key: TabKey; href: string; label: string; icon: typeof Menu } | null)[] = [
  { key: 'today', href: '/today', label: 'Today', icon: CalendarCheck },
  { key: 'projects', href: '/projects', label: 'Projects', icon: FolderOpen },
  null, // + in the middle
  { key: 'claude', href: '/claude', label: 'Claude', icon: Sparkles },
  { key: 'tasks', href: '/tasks', label: 'Tasks', icon: LayoutList },
];

/** Phone navigation: Today, Projects, a centre "add" button, Claude and Tasks, above the home indicator. */
export function TabBar() {
  const path = usePathname();
  const router = useRouter();
  const { badges } = useApp();
  const [adding, setAdding] = useState(false);
  const lit = phoneTabOf(path);
  const count: Record<TabKey, number> = { today: badges.overdue, claude: badges.claudeWaiting, projects: 0, tasks: 0 };
  // Home-screen shortcut "New task" opens /today?add=1.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('add') !== '1') return;
    const t = setTimeout(() => setAdding(true), 0);
    router.replace(path);
    return () => clearTimeout(t);
  }, [path, router]);
  return (
    <>
      <nav
        aria-label="Main"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/85 backdrop-blur-xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="grid grid-cols-5 h-16">
          {TABS.map((t, i) =>
            t ? (
              <Link
                key={t.href}
                href={t.href}
                replace
                aria-current={lit === t.key ? 'page' : undefined}
                onClick={e => {
                  // The lit tab again: scroll to the top (when already at its root).
                  if (lit === t.key && path === t.href && !window.location.search) {
                    e.preventDefault();
                    document.getElementById('app-main')?.scrollTo({ top: 0, behavior: 'smooth' });
                  }
                }}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors active:scale-95',
                  lit === t.key ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="relative">
                  <t.icon className="w-6 h-6" strokeWidth={lit === t.key ? 2.4 : 1.8} />
                  {count[t.key] > 0 && (
                    <span
                      data-badge={t.key}
                      className="absolute -top-1.5 -right-3 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] font-semibold leading-[18px] text-center"
                    >
                      {count[t.key] > 99 ? '99+' : count[t.key]}
                    </span>
                  )}
                </span>
                {t.label}
              </Link>
            ) : (
              <div key={i} className="flex items-center justify-center">
                <button
                  onClick={() => setAdding(true)}
                  aria-label="Add"
                  className="w-14 h-14 -mt-5 rounded-full bg-foreground text-background shadow-lg shadow-black/20 flex items-center justify-center active:scale-95 transition-transform"
                >
                  <Plus className="w-7 h-7" strokeWidth={2.4} />
                </button>
              </div>
            ),
          )}
        </div>
      </nav>
      <QuickAddSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

/**
 * Sticky phone header for a top-level screen: title, then search (Tasks search), the Inbox bell and Menu, each 44px.
 * `nav={false}` keeps only the bell (screens reached from a parent, which have their own Back).
 */
export function MobileHeader({
  title,
  subtitle,
  right,
  bell = true,
  nav = true,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  bell?: boolean;
  nav?: boolean;
}) {
  const path = usePathname();
  return (
    <header
      className="md:hidden sticky -top-3 z-30 -mx-4 -mt-3 px-4 pb-3 pt-3 bg-background/85 backdrop-blur-xl"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight text-foreground truncate">{title}</h1>
          {subtitle && <div className="text-sm text-muted-foreground mt-0.5">{subtitle}</div>}
        </div>
        {(right || bell || nav) && (
          <div className="flex items-center shrink-0">
            {right}
            {nav && (
              <button type="button" onClick={openSearch} aria-label="Search" className="w-11 h-11 flex items-center justify-center rounded-full active:bg-muted">
                <Search className="w-[22px] h-[22px]" />
              </button>
            )}
            {bell && <BellButton />}
            {nav && path !== '/menu' && (
              <Link href="/menu" aria-label="Menu" className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full active:bg-muted">
                <Menu className="w-[22px] h-[22px]" />
              </Link>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
