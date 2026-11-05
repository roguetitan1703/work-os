'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { useApp } from '@/components/app-context';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import { assigneeOptions, initials } from '@/lib/assignees';
import { cn } from '@/lib/utils';

/** "Nobody", "Me", "Me, Bea" … for a picker button. */
export function assigneeLabel(ids: string[], people: Record<string, string>, me: string): string {
  if (!ids.length) return 'Nobody';
  return ids.map(id => (id === me ? 'Me' : (people[id] ?? 'A former member'))).join(', ');
}

/**
 * Who does a task (several people may): a button that opens a sheet (phone) or dialog (desktop) with a tick per
 * member. Nothing is saved until Save, so ticking a few people is one change (and one alert each for the new ones).
 */
export function AssigneePicker({ value, onSave, children }: { value: string[]; onSave: (ids: string[]) => void; children: (label: string, open: () => void) => React.ReactNode }) {
  const { people, me } = useApp();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(value);
  const show = () => {
    setPicked(value);
    setOpen(true);
  };
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const same = picked.length === value.length && picked.every(id => value.includes(id));
  return (
    <>
      {children(assigneeLabel(value, people, me), show)}
      {open && (
        <ResponsiveSheet title="Who does it" onClose={() => setOpen(false)}>
          <div className="space-y-1 pb-2" data-assignee-sheet>
            {assigneeOptions(people, me, value).map(o => {
              const on = picked.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-assignee-option={o.id}
                  onClick={() => toggle(o.id)}
                  className="w-full flex items-center gap-3 px-3 min-h-11 md:min-h-9 rounded-xl text-left text-[16px] md:text-sm text-foreground hover:bg-muted/60 active:bg-muted/60"
                >
                  <span className={cn('w-5 h-5 rounded-md border flex items-center justify-center shrink-0', on ? 'bg-foreground border-foreground text-background' : 'border-border')}>
                    {on && <Check className="w-3.5 h-3.5" />}
                  </span>
                  <span className="flex-1 truncate">{o.name}</span>
                </button>
              );
            })}
            <div className="flex gap-2 pt-3">
              <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-medium border border-border text-foreground" onClick={() => setPicked([])} disabled={!picked.length}>
                Nobody
              </button>
              <button
                type="button"
                data-assignee-save
                className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-semibold bg-foreground text-background disabled:opacity-50"
                disabled={same}
                onClick={() => {
                  setOpen(false);
                  onSave(picked);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </ResponsiveSheet>
      )}
    </>
  );
}

/** Small initials of a task's assignees for a row; up to three, then +N. Nothing when nobody is assigned. */
export function AssigneeDots({ ids, className }: { ids: string[]; className?: string }) {
  const { people, me } = useApp();
  if (!ids.length) return null;
  const names = ids.map(id => (id === me ? 'Me' : (people[id] ?? 'A former member')));
  const shown = ids.slice(0, 3);
  return (
    <span className={cn('inline-flex items-center -space-x-1 shrink-0', className)} title={`Assigned to ${names.join(', ')}`} aria-label={`Assigned to ${names.join(', ')}`} data-assignees={ids.length}>
      {shown.map((id, i) => (
        <span
          key={id}
          className={cn(
            'w-5 h-5 rounded-full border border-background text-[9px] font-semibold flex items-center justify-center',
            id === me ? 'bg-foreground text-background' : 'bg-muted text-foreground',
          )}
        >
          {initials(id === me ? (people[me] ?? 'Me') : names[i])}
        </span>
      ))}
      {ids.length > 3 && <span className="w-5 h-5 rounded-full border border-background bg-muted text-[9px] font-semibold flex items-center justify-center">+{ids.length - 3}</span>}
    </span>
  );
}
