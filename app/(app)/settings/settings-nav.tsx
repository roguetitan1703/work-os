'use client';

import Link from '@/components/intent-link';
import { SearchButton } from '@/components/search-button';
import { NavIcon } from '@/components/nav-icons';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';
import { SECTION_ICON } from './section-icons';
import type { GroupId, SectionDef, SectionId } from './sections';


/**
 * The left list of Settings (desktop): a search button (the global search on Settings, which finds each setting by
 * name), muted group labels, an icon and a label per section, the open one as a soft pill. Phone has its own list (page.tsx).
 */
export function SettingsNav({ items, active, dot }: { items: SectionDef[]; active: SectionId; dot?: SectionId | null }) {
  const groups = (['You', 'Team', 'Server'] as GroupId[]).map(g => ({ g, rows: items.filter(s => s.group === g) })).filter(x => x.rows.length);
  return (
    <nav aria-label="Settings sections" className="hidden md:block">
      <div className="sticky top-4">
        <SearchButton kind="settings" label="Search settings" data-settings-search className="w-full justify-start mb-3" />
        {groups.map(({ g, rows }) => (
          <div key={g} className="mb-3" data-settings-group={g}>
            <div className={cn(ui.sectionLabel, 'px-2.5 mb-1')}>{g}</div>
            <ul className="space-y-0.5">
              {rows.map(s => (
                <li key={s.id}>
                  <Link href={`/settings?section=${s.id}`} scroll={false} aria-current={s.id === active ? 'page' : undefined} data-section={s.id} className={cn(ui.row, s.id === active ? ui.rowOn : ui.rowOff)}>
                    <NavIcon icon={SECTION_ICON[s.id]} className="text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">{s.label}</span>
                    {dot === s.id && <span data-settings-dot role="img" aria-label="Needs a look" className="w-2 h-2 rounded-full bg-amber-500" />}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

