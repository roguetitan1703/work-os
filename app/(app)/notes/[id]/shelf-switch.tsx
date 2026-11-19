'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/select';
import { SHELVES, shelfLabel, type Shelf } from '@/lib/notes-shelves';
import { setShelfAction } from '../actions';

/**
 * The shelf a project note sits on (Overview, Designs, Runbooks; Handovers only on a handover). Beside the Orders switch in
 * the note's header; the project page and the Notes filter group by it.
 */
export function ShelfSwitch({ noteId, current, isHandover }: { noteId: string; current: Shelf; isHandover: boolean }) {
  const [shelf, setShelf] = useState<Shelf>(current);
  const [pending, start] = useTransition();
  const change = (next: Shelf) =>
    start(async () => {
      const r = await setShelfAction(noteId, next);
      if ('error' in r) return void toast.error(r.error);
      setShelf(next);
      toast.success(`Moved to ${shelfLabel(next)}`);
    });
  return (
    <span className="inline-flex items-center gap-1.5 min-h-9 md:min-h-0" data-shelf-switch data-shelf={shelf}>
      <label className="flex items-center gap-1.5">
        <span>Shelf</span>
        <Select
          aria-label="Shelf of this note"
          value={shelf}
          disabled={pending}
          onChange={e => change(e.target.value as Shelf)}
          className="h-9 md:h-7 rounded-md border border-input bg-background px-2 text-base md:text-xs text-foreground"
          data-shelf-select
        >
          {SHELVES.filter(x => x.id !== 'handovers' || isHandover).map(x => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </Select>
      </label>
    </span>
  );
}
