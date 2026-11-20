'use client';

import Link from '@/components/intent-link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, Plus, Search } from 'lucide-react';
import { PLACE_ICON } from '../nav-icons';
import { cn } from '@/lib/utils';
import { phoneTabOf } from '@/lib/nav';
import { useApp } from '../app-context';
import { QuickAddSheet } from './quick-add-sheet';
import { NewNoteSheet } from './m-notes';
import { BellButton } from './bell';
import { openSearch } from '../global-search';
import { PageHeader } from '../ui/page';
import { IconButton } from '../ui/icon-button';

type TabKey = 'today' | 'projects' | 'needs' | 'claude';
const TABS: ({ key: TabKey; href: string; label: string; icon: typeof Menu } | null)[] = [
  { key: 'today', href: '/today', label: 'Today', icon: PLACE_ICON.today },
  { key: 'projects', href: '/projects', label: 'Projects', icon: PLACE_ICON.projects },
  null, // + in the middle
  { key: 'needs', href: '/needs', label: 'Needs', icon: PLACE_ICON.needs },
  { key: 'claude', href: '/claude', label: 'Claude', icon: PLACE_ICON.claude },
];

/** Phone navigation: Today, Projects, a centre "add" button, Needs and Claude, above the home indicator. Tasks is first in the Menu. */
export function TabBar() {
  const path = usePathname();
  const router = useRouter();
  const { badges, projects } = useApp();
  const [adding, setAdding] = useState(false);
  const [noting, setNoting] = useState(false);
  const lit = phoneTabOf(path);
  // A note can file under any project, active ones first.
  const open = (s: string) => s === 'active' || s === 'paused';
  const noteProjects = [...projects.filter(p => open(p.status)), ...projects.filter(p => !open(p.status))].map(p => ({ id: p.id, name: p.name, private: p.visibility === 'private' }));
  const count: Record<TabKey, number> = { today: badges.overdue, needs: badges.needs ?? 0, projects: 0, claude: 0 };
  // Home-screen shortcut "New task" opens /today?add=1.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('add') !== '1') return;
    const t = setTimeout(() => setAdding(true), 0);
    router.replace(path);
    return () => clearTimeout(t);
  }, [path, router]);
  // The first-run checklist's Add a task button (the desktop dialog listens on wide screens only).
  useEffect(() => {
    const open = () => window.innerWidth < 768 && setAdding(true);
    window.addEventListener('wos:quick-add', open);
    return () => window.removeEventListener('wos:quick-add', open);
  }, []);
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
                  'relative flex flex-col items-center justify-center gap-1 text-label font-medium transition-colors active:scale-95',
                  lit === t.key ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="relative">
                  <t.icon className="w-6 h-6" strokeWidth={lit === t.key ? 2.2 : 1.6} aria-hidden />
                  {count[t.key] > 0 && (
                    <span data-badge={t.key} className="absolute -top-1.5 -right-3 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-label font-semibold leading-[18px] text-center">
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
      <QuickAddSheet open={adding} onClose={() => setAdding(false)} onNewNote={() => setNoting(true)} />
      {noting && <NewNoteSheet projects={noteProjects} onClose={() => setNoting(false)} />}
    </>
  );
}

/**
 * One header for both sizes: MobileHeader on the phone, PageHeader from md (the sidebar holds search, bell and menu
 * there, so the desktop header carries only `actions`). `back` is the phone's parent (the Menu for Menu pages).
 */
export function ScreenHeader({
  title,
  sub,
  desktopSub,
  back,
  backLabel,
  right,
  actions,
  bell,
  className,
}: {
  title: string;
  /** Class for the desktop header (spacing below it). */
  className?: string;
  sub?: React.ReactNode;
  /** A longer sub line for the desktop header (defaults to `sub`). */
  desktopSub?: React.ReactNode;
  back?: string;
  backLabel?: string;
  /** Phone-only controls before Search. */
  right?: React.ReactNode;
  /** Desktop-only controls at the right of the title. */
  actions?: React.ReactNode;
  bell?: boolean;
}) {
  return (
    <>
      <MobileHeader title={title} subtitle={sub} back={back} backLabel={backLabel} right={right} bell={bell} />
      <PageHeader className={cn('hidden md:block', className)} title={title} sub={desktopSub ?? sub} actions={actions} />
    </>
  );
}

/**
 * The phone header, the same on every screen: an optional back link (`back`, `backLabel`), the big title and one sub
 * line, then the page's own controls (`right`), Search, the Inbox bell and Menu, each 44px. Built on PageHeader.
 * `bell={false}` drops the bell (the Inbox itself). Phone only; desktop pages keep their own heading.
 */
export function MobileHeader({
  title,
  subtitle,
  right,
  back,
  backLabel,
  bell = true,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  back?: string;
  backLabel?: string;
  bell?: boolean;
}) {
  const path = usePathname();
  const { badges } = useApp();
  // Something inside the Menu wants a look: something new (blue).
  const menuDot = badges.whatsNew ? 'bg-blue-500' : null;
  return (
    <div
      data-phone-header
      className="md:hidden sticky -top-3 z-30 -mx-4 -mt-3 px-4 pb-3 pt-3 bg-background/85 backdrop-blur-xl"
      style={{ paddingTop: back ? 'env(safe-area-inset-top)' : 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <PageHeader
        title={title}
        sub={subtitle}
        back={back}
        backLabel={backLabel}
        actions={
          <div className="flex items-center -mr-2 gap-0">
            {right}
            <IconButton label="Search" onClick={openSearch} className="rounded-full text-foreground">
              <Search className="size-[22px]" />
            </IconButton>
            {bell && <BellButton />}
            {path !== '/menu' && (
              <Link href="/menu" aria-label={menuDot ? 'Menu, something new' : 'Menu'} className="relative w-11 h-11 flex items-center justify-center rounded-full active:bg-muted">
                <Menu className="size-[22px]" />
                {menuDot && <span data-menu-dot className={cn('absolute right-2 top-2.5 w-2 h-2 rounded-full ring-2 ring-background', menuDot)} aria-hidden />}
              </Link>
            )}
          </div>
        }
      />
    </div>
  );
}
