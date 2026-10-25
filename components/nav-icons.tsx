import { CalendarCheck, CalendarClock, FileText, Folder, History, Inbox, ListChecks, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ICON } from '@/lib/ui-tokens';

/** One icon per place, used everywhere that place appears: sidebar, phone tabs and Menu, Claude and Settings lists, empty states. */
export const PLACE_ICON = {
  today: CalendarCheck,
  tasks: ListChecks,
  projects: Folder,
  notes: FileText,
  claude: Sparkles,
  inbox: Inbox,
  review: History,
  schedule: CalendarClock,
  settings: Settings,
} as const satisfies Record<string, LucideIcon>;

/** A quiet lucide icon at the shared size and stroke. */
export function NavIcon({ icon: I, className, size = ICON.size, strokeWidth = ICON.strokeWidth }: { icon: LucideIcon; className?: string; size?: number; strokeWidth?: number }) {
  return <I size={size} strokeWidth={strokeWidth} aria-hidden className={cn('shrink-0', className)} />;
}
