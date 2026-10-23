'use client';

import { Lock, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Sharing = 'org' | 'private';

export const SHARING_HELP = 'Shared: everyone in Delpat sees it and its tasks and notes. Private: only you.';

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
