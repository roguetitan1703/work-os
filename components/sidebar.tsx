import Link from "next/link";
import { readData } from "@/lib/storage";
import { MODES, modeToSlug } from "@/lib/modes";
import { differenceInDays, parseISO } from "date-fns";
import { ThemeToggle } from "./theme-toggle";

function getHiddenCount(): number {
  try {
    const data = readData();
    const today = new Date();
    return data.tasks.filter((t) => {
      if (t.status === "Done" || t.status === "Dropped") return false;
      const days = differenceInDays(today, parseISO(t.lastTouched));
      return days > 7;
    }).length;
  } catch {
    return 0;
  }
}

export function Sidebar() {
  const hiddenCount = getHiddenCount();

  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 border-r bg-white dark:bg-black flex flex-col overflow-y-auto">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <span className="font-bold text-sm tracking-tight text-gray-900 dark:text-white">
          Work OS
        </span>
      </div>

      <nav className="flex-1 p-3 space-y-1 text-sm">
        <NavItem href="/today">Today</NavItem>

        <div className="pt-2 pb-1">
          <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-2">
            Modes
          </span>
        </div>
        {MODES.map((mode) => (
          <Link
            key={mode.name}
            href={`/modes/${modeToSlug(mode.name)}`}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: mode.hex }}
            />
            <span className="truncate">{mode.name}</span>
          </Link>
        ))}

        <div className="pt-2" />
        <NavItem href="/hidden">
          <span className="flex items-center justify-between w-full">
            Hidden Work
            {hiddenCount > 0 && (
              <span className="text-xs bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 rounded-full px-1.5 py-0.5 font-medium">
                {hiddenCount}
              </span>
            )}
          </span>
        </NavItem>
        <NavItem href="/archive">Archive</NavItem>
        <NavItem href="/review">Weekly Review</NavItem>
        <NavItem href="/timetable">Timetable</NavItem>
        <NavItem href="/recovery">Recovery</NavItem>
      </nav>

      <div className="p-3 border-t border-gray-200 dark:border-gray-700">
        <ThemeToggle />
      </div>
    </aside>
  );
}

function NavItem({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors w-full"
    >
      {children}
    </Link>
  );
}
