'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CalendarCheck, FileText, LayoutList, Menu, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { QuickAddSheet } from './quick-add-sheet';

const TABS = [
  { href: '/today', label: 'Today', icon: CalendarCheck, match: ['/today'] },
  { href: '/board', label: 'Tasks', icon: LayoutList, match: ['/board', '/tasks', '/projects'] },
  null, // + in the middle
  { href: '/notes', label: 'Notes', icon: FileText, match: ['/notes'] },
  { href: '/more', label: 'More', icon: Menu, match: ['/more', '/history', '/connect', '/hidden', '/review', '/timetable', '/recovery', '/modes', '/archive'] },
] as const;

/** Phone navigation: four tabs and a centre "add" button, above the home indicator. */
export function TabBar() {
  const path = usePathname();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
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
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/85 backdrop-blur-xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="grid grid-cols-5 h-16">
          {TABS.map((t, i) =>
            t ? (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors active:scale-95',
                  t.match.some(m => path.startsWith(m)) ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <t.icon className="w-6 h-6" strokeWidth={t.match.some(m => path.startsWith(m)) ? 2.4 : 1.8} />
                {t.label}
              </Link>
            ) : (
              <div key={i} className="flex items-center justify-center">
                <button
                  onClick={() => setAdding(true)}
                  aria-label="Add task"
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

/** Sticky phone header: big title, optional subtitle and right-side actions. */
export function MobileHeader({ title, subtitle, right }: { title: string; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header
      className="md:hidden sticky -top-3 z-30 -mx-4 -mt-3 px-4 pb-3 pt-3 bg-background/85 backdrop-blur-xl"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight text-foreground truncate">{title}</h1>
          {subtitle && <div className="text-sm text-muted-foreground mt-0.5">{subtitle}</div>}
        </div>
        {right && <div className="flex items-center gap-1 shrink-0">{right}</div>}
      </div>
    </header>
  );
}
