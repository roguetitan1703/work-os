'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/select';
import { setOrdersAction } from '../orders-actions';

type Layer = 'org' | 'project' | 'person';
const NAMES: Record<Layer, string> = { org: 'the organization’s Orders', project: 'this project’s Orders', person: 'my Orders' };

/**
 * Marks this page as standing Orders: rules every AI reads first when it starts work (start_work). A page marked so is
 * changed by the person who holds that layer, here or through their own Claude (write_note, with a why); every change keeps a
 * version with undo (Changes, under the page). The flag itself is set here only.
 */
export function OrdersSwitch({ noteId, current, options, updatedAt }: { noteId: string; current: Layer | null; options: Layer[]; updatedAt: number }) {
  const [layer, setLayer] = useState<Layer | null>(current);
  const [pending, start] = useTransition();
  const change = (next: Layer | null) =>
    start(async () => {
      const r = await setOrdersAction(noteId, next, updatedAt);
      if ('error' in r) return void toast.error(r.error);
      setLayer(next);
      toast.success(next ? `Now ${NAMES[next]}` : 'No longer Orders');
    });
  return (
    <span className="inline-flex items-center gap-1.5 min-h-9 md:min-h-0" data-orders-switch data-orders={layer ?? ''}>
      <label className="flex items-center gap-1.5">
        <span>Orders</span>
        <Select
          aria-label="Use this page as Orders"
          value={layer ?? ''}
          disabled={pending || (!options.length && !layer)}
          onChange={e => change((e.target.value || null) as Layer | null)}
          className="h-9 md:h-7 rounded-md border border-input bg-background px-2 text-base md:text-xs text-foreground"
          data-orders-select
        >
          <option value="">Not Orders</option>
          {(['person', 'project', 'org'] as Layer[]).map(l => (
            <option key={l} value={l} disabled={!options.includes(l) && l !== layer}>
              {l === 'org' ? 'Organization' : l === 'project' ? 'This project' : 'Mine'}
            </option>
          ))}
        </Select>
      </label>
    </span>
  );
}
