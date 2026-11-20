'use client';

import { useState, useTransition } from 'react';
import { Gauge } from 'lucide-react';
import { toast } from 'sonner';
import { setContextWarnAction } from '@/app/actions';
import { Select } from '@/components/ui/select';

/**
 * Context warning (note 3e92845ac0): the size of a Claude session's context (in thousands of tokens) after which the Work OS hook tells it to
 * write a code-map note and stop. Off by default. One row like Nudges: a summary and one control on the right. Set here only, never by an agent.
 */
export function ContextWarnSetting({ projectId, initial }: { projectId: string; initial: 150 | 200 | null }) {
  const [line, setLine] = useState<150 | 200 | null>(initial);
  const [pending, start] = useTransition();

  const pick = (v: string) =>
    start(async () => {
      const r = await setContextWarnAction(projectId, v === '' ? null : Number(v));
      if (!r.ok) return void toast.error(r.error);
      setLine(r.data);
      toast(r.data ? `Context warning at ${r.data}k` : 'Context warning off');
    });

  return (
    <div className="space-y-1.5" data-part="context-warn">
      <h3 className="text-[13px] md:text-xs font-semibold text-foreground px-1 md:px-0">Context warning</h3>
      <p className="text-[13px] md:text-xs text-muted-foreground px-1 md:px-0">Claude is told to write a code-map note and stop when its context grows past this size.</p>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-context-warn-row>
          <Gauge className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] md:text-sm break-words" data-context-warn-summary>{line ? `At ${line}k` : 'Off'}</div>
            <div className="text-[13px] md:text-xs text-muted-foreground truncate">{line ? 'Claude is warned, then told to stop' : 'Claude is left alone'}</div>
          </div>
          <Select
            className="h-11 md:h-8 w-24 shrink-0 rounded-full border-transparent bg-transparent dark:bg-transparent px-3 text-[13px] font-medium text-muted-foreground"
            value={line ? String(line) : ''}
            onChange={e => pick(e.target.value)}
            disabled={pending}
            aria-label="Context warning"
          >
            <option value="">Off</option>
            <option value="150">150k</option>
            <option value="200">200k</option>
          </Select>
        </div>
      </div>
    </div>
  );
}
