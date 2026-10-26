'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/intent-link';
import { Search } from 'lucide-react';
import { NavIcon } from '@/components/nav-icons';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';
import { SECTION_ICON } from './section-icons';
import type { GroupId, SectionDef, SectionId } from './sections';


/**
 * The left list of Settings (desktop): a search box that filters the sections, muted group labels, an icon and a label
 * per section, the open one as a soft pill. Phone has its own list (page.tsx).
 */
export function SettingsNav({ items, active, dot }: { items: SectionDef[]; active: SectionId; dot?: SectionId | null }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter(s => `${s.label} ${s.group} ${s.keywords}`.toLowerCase().includes(needle)) : items;
  const groups = (['You', 'Team', 'Server'] as GroupId[]).map(g => ({ g, rows: shown.filter(s => s.group === g) })).filter(x => x.rows.length);
  return (
    <nav aria-label="Settings sections" className="hidden md:block">
      <div className="sticky top-4">
        <label className="relative block mb-3">
          <span className="sr-only">Search settings</span>
          <Search size={16} strokeWidth={1.6} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && shown.length >= 1) router.push(`/settings?section=${shown[0].id}`);
              if (e.key === 'Escape') setQ('');
            }}
            placeholder="Search settings"
            data-settings-search
            className="w-full h-9 rounded-lg border border-input bg-background dark:bg-input/30 pl-9 pr-3 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
        {groups.length === 0 && <p data-settings-nomatch className="px-2.5 text-[13px] text-muted-foreground">No setting matches &ldquo;{q.trim()}&rdquo;.</p>}
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

