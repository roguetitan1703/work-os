'use client';

import { Lock, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Sharing = 'org' | 'private';

export const SHARING_HELP = 'Shared: everyone in Delpat sees it and its tasks and notes. Private: only you.';

/**
 * Under Shared in the New project dialog: Everyone (default) or Choose people (members to tick; you are always on it).
 * `picked` null = everyone.
 */
export function AudiencePicker({ people, me, picked, onChange }: { people: Record<string, string>; me: string; picked: string[] | null; onChange: (v: string[] | null) => void }) {
  const others = Object.keys(people).filter(u => u !== me).sort((a, b) => people[a].localeCompare(people[b]));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Shared with" data-audience-choice>
        {([['everyone', 'Everyone'], ['people', 'Choose people']] as const).map(([v, label]) => {
          const on = v === 'people' ? picked !== null : picked === null;
          return (
            <button key={v} type="button" role="radio" aria-checked={on} data-audience={v} onClick={() => !on && onChange(v === 'people' ? [] : null)} className={cn('h-11 md:h-9 rounded-lg text-sm font-medium', on ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}>
              {label}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="rounded-xl border border-border/70 divide-y divide-border/60 max-h-48 overflow-y-auto" data-people-picker>
          <label className="flex items-center gap-3 px-3 min-h-11 md:min-h-9 text-sm" data-person={me}>
            <input type="checkbox" className="w-4 h-4" checked disabled />
            <span className="flex-1">You</span>
          </label>
          {others.map(u => (
            <label key={u} className="flex items-center gap-3 px-3 min-h-11 md:min-h-9 text-sm" data-person={u}>
              <input type="checkbox" className="w-4 h-4" checked={picked.includes(u)} onChange={e => onChange(e.target.checked ? [...picked, u] : picked.filter(x => x !== u))} />
              <span className="flex-1 min-w-0 truncate">{people[u]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared / Private choice for a project (new-project dialog and the project's Info tab). */
export function SharingChoice({ value, onChange, disabled }: { value: Sharing; onChange: (v: Sharing) => void; disabled?: boolean }) {
  const opts: { v: Sharing; label: string; icon: React.ReactNode }[] = [
    { v: 'org', label: 'Shared', icon: <Users className="w-4 h-4" /> },
    { v: 'private', label: 'Private', icon: <Lock className="w-4 h-4" /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Who sees this project" data-sharing-choice>
      {opts.map(o => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          data-sharing={o.v}
          onClick={() => value !== o.v && onChange(o.v)}
          className={cn('h-11 md:h-9 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-60', value === o.v ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}
