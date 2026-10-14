'use client';

import { useMemo, useState, useTransition } from 'react';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { saveBlockedChannels } from './actions';

type Row = { id: string; name: string; type: string; parentId: string | null; blocked: boolean };

/** Pick channels/categories Work OS must never read (passwords, credentials, anything sensitive). */
export function BlockedChannels({ layout }: { layout: Row[] }) {
  const initial = useMemo(() => new Set(layout.filter(r => r.blocked).map(r => r.id)), [layout]);
  const [sel, setSel] = useState<Set<string>>(initial);
  const [pending, start] = useTransition();
  const dirty = sel.size !== initial.size || [...sel].some(id => !initial.has(id));

  const categories = layout.filter(r => r.type === 'category');
  const loose = layout.filter(r => r.type !== 'category' && !r.parentId);
  const childrenOf = (id: string) => layout.filter(r => r.parentId === id && r.type !== 'category');

  const toggle = (id: string) =>
    setSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const channelRow = (r: Row, viaCategory: boolean) => {
    const on = viaCategory || sel.has(r.id);
    return (
      <label
        key={r.id}
        className={cn('flex items-center gap-3 md:gap-2 px-3 min-h-11 md:min-h-0 md:py-1.5 text-[15px] md:text-sm rounded-md hover:bg-muted/60 active:bg-muted/60', viaCategory ? 'cursor-default' : 'cursor-pointer')}
      >
        <input type="checkbox" checked={on} disabled={viaCategory} onChange={() => toggle(r.id)} className="accent-red-600 w-5 h-5 md:w-4 md:h-4 shrink-0" />
        <span className={cn(on ? 'text-red-700 dark:text-red-300' : 'text-foreground')}>#{r.name}</span>
        {on && <Lock className="w-3 h-3 text-red-600" />}
      </label>
    );
  };

  return (
    <div className="space-y-3">
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border max-h-[28rem] overflow-y-auto p-2 space-y-2">
        {loose.length > 0 && <div>{loose.map(r => channelRow(r, false))}</div>}
        {categories.map(cat => {
          const catOn = sel.has(cat.id);
          const kids = childrenOf(cat.id);
          return (
            <div key={cat.id}>
              <label className="flex items-center gap-3 md:gap-2 px-3 min-h-11 md:min-h-0 md:py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer rounded-md hover:bg-muted/60">
                <input type="checkbox" checked={catOn} onChange={() => toggle(cat.id)} className="accent-red-600 w-5 h-5 md:w-4 md:h-4 shrink-0" />
                {cat.name}
                <span className="font-normal normal-case tracking-normal">· {catOn ? 'whole category blocked' : `${kids.length} channels`}</span>
              </label>
              <div className="pl-3 md:pl-5">{kids.map(r => channelRow(r, catOn))}</div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          disabled={!dirty || pending}
          onClick={() =>
            start(async () => {
              try {
                await saveBlockedChannels([...sel]);
                toast.success(`Saved: ${sel.size} blocked`);
              } catch {
                toast.error('Could not save');
              }
            })
          }
          className="px-5 md:px-3 h-11 md:h-auto md:py-1.5 rounded-xl md:rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-40"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <span className="text-xs text-muted-foreground">
          {sel.size} blocked{dirty ? ' · unsaved changes' : ''}. Threads inside a blocked channel or category are blocked too.
        </span>
      </div>
    </div>
  );
}
