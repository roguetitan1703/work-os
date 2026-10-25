'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useModes } from './app-context';
import { ResponsiveSheet } from './responsive-sheet';

/** "What are these?" next to the Kind of work filter: the organization's modes and what each one is for. */
export function ModeHelp({ className, chip }: { className?: string; chip?: boolean }) {
  const [open, setOpen] = useState(false);
  const { modes } = useModes();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-mode-help
        className={cn(
          chip
            ? 'shrink-0 h-11 px-4 rounded-full border border-dashed border-border text-sm font-medium whitespace-nowrap text-muted-foreground active:scale-95 transition-transform'
            : 'inline-flex items-center min-h-11 md:min-h-8 px-1 text-sm md:text-xs text-muted-foreground underline hover:text-foreground',
          className,
        )}
      >
        What are these?
      </button>
      {open && (
        <ResponsiveSheet title="Kinds of work" onClose={() => setOpen(false)}>
          <div className="space-y-2 pb-2" data-mode-help-list>
            <p className="text-[15px] md:text-sm text-muted-foreground">Each task can have one kind of work. It is optional; use it to see, say, all the sales tasks together.</p>
            {modes.map(m => (
              <div key={m.name} className="rounded-xl border p-3" style={{ backgroundColor: m.hex + '18', borderColor: m.hex + '40' }}>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.hex }} />
                  <span className="font-semibold text-[16px] md:text-sm text-foreground">{m.name}</span>
                </div>
                {m.description && <p className="mt-1 text-[15px] md:text-sm text-foreground/70">{m.description}</p>}
              </div>
            ))}
          </div>
        </ResponsiveSheet>
      )}
    </>
  );
}
