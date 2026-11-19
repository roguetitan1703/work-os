'use client';

import { useState, useTransition } from 'react';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { setNudgesAction } from '@/app/actions';

const iconBtn = 'h-11 md:h-8 px-3 rounded-full inline-flex items-center justify-center gap-1 text-[13px] font-medium text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

/**
 * Nudges: whether Work OS asks this project's Claude sessions to carry on when they stop with work left, and to declutter a long State
 * (note ce434ed759). On by default. One row like Production: a summary and one button on the right. Set here only, never by an agent.
 */
export function NudgesSetting({ projectId, initial }: { projectId: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();

  const flip = () =>
    start(async () => {
      const r = await setNudgesAction(projectId, !on);
      if (!r.ok) return void toast.error(r.error);
      setOn(r.data);
      toast(r.data ? 'Nudges on' : 'Nudges off');
    });

  return (
    <div className="space-y-1.5" data-part="nudges">
      <h3 className="text-[13px] md:text-xs font-semibold text-foreground px-1 md:px-0">Nudges</h3>
      <p className="text-[13px] md:text-xs text-muted-foreground px-1 md:px-0">Claude is asked to carry on when it stops with work left that waits on nobody, and to declutter a long State.</p>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-nudges-row>
          <BellRing className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] md:text-sm break-words" data-nudges-summary>{on ? 'On' : 'Off'}</div>
            <div className="text-[13px] md:text-xs text-muted-foreground truncate">{on ? 'Claude moves on by itself' : 'Claude is left alone'}</div>
          </div>
          <button type="button" className={iconBtn} onClick={flip} disabled={pending} data-nudges-toggle>
            {on ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>
    </div>
  );
}
