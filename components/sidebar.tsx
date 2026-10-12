import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { MODES, modeToSlug } from '@/lib/modes';
import { logoutAction } from '@/app/actions';
import { uiAuthDisabled } from '@/lib/auth';
import type { Stats } from '@/lib/data/summary';
import { ThemeToggle } from './theme-toggle';
import { QuickAddLauncher } from './quick-add';

export function Sidebar({ stats, hiddenCount }: { stats: Stats; hiddenCount: number }) {
  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 border-r bg-white dark:bg-black flex flex-col overflow-y-auto">
      <div className="p-4 border-b border-border">
        <span className="font-bold text-sm tracking-tight text-foreground">Work OS</span>
      </div>

      <div className="p-3 pb-0">
        <QuickAddLauncher />
      </div>

      <nav className="flex-1 p-3 space-y-0.5 text-sm">
        <NavItem href="/today" count={stats.overdue + stats.dueToday || undefined} countTone={stats.overdue ? 'red' : undefined}>
          Today
        </NavItem>
        <NavItem href="/board">Board</NavItem>
        <NavItem href="/projects">Projects</NavItem>
        <NavItem href="/history">History</NavItem>

        <div className="pt-3 pb-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Modes</span>
        </div>
        {MODES.map(mode => (
          <Link
            key={mode.name}
            href={`/modes/${modeToSlug(mode.name)}`}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-foreground/80 transition-colors"
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: mode.hex }} />
            <span className="truncate">{mode.name}</span>
          </Link>
        ))}

        <div className="pt-3" />
        <NavItem href="/hidden" count={hiddenCount || undefined} countTone="amber">
          Hidden Work
        </NavItem>
        <NavItem href="/review">Weekly Review</NavItem>
        <NavItem href="/timetable">Timetable</NavItem>
        <NavItem href="/recovery">Recovery</NavItem>
      </nav>

      <div className="p-3 border-t border-border flex items-center justify-between">
        <ThemeToggle />
        {!uiAuthDisabled() && (
          <form action={logoutAction}>
            <button type="submit" className="p-2 rounded-md text-muted-foreground hover:bg-muted" title="Sign out">
              <LogOut className="w-4 h-4" />
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}

function NavItem({
  href,
  children,
  count,
  countTone,
}: {
  href: string;
  children: React.ReactNode;
  count?: number;
  countTone?: 'red' | 'amber';
}) {
  const tone =
    countTone === 'red'
      ? 'bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300'
      : countTone === 'amber'
        ? 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return (
    <Link href={href} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted text-foreground/80 transition-colors w-full">
      {children}
      {count ? <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${tone}`}>{count}</span> : null}
    </Link>
  );
}
