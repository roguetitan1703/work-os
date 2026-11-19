'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { ActorBadge } from '@/components/actor-badge';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/format';
import type { OrdersHistory } from '@/lib/data/orders';
import { undoOrdersAction } from '../orders-actions';

const SHOWN = 3;

/**
 * The versions of an Orders page, newest first, built like the task page's history list (components/activity-timeline.tsx): who,
 * when, the session, why, the lines taken out (red) and put in (green). The holder gets one button on the right of each row:
 * Undo on the newest version, Restore on an older one (it asks first). Either writes the text before that change as a new version.
 */
export function OrdersChanges({ history }: { history: OrdersHistory }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const [pending, start] = useTransition();
  const list = all ? history.log : history.log.slice(0, SHOWN);
  const undo = (v: number, newest: boolean) =>
    start(async () => {
      if (!newest && !confirm(`Restore the text before v${v}? It becomes a new version; later changes stay in the list.`)) return;
      const r = await undoOrdersAction(history.noteId, v, new Date(history.updatedAt).getTime());
      if ('error' in r) return void toast.error(r.error);
      toast.success(`Back to the text before v${v}: now v${r.version}`);
      router.refresh();
    });
  if (!history.log.length) return null;
  return (
    <section className="space-y-2" data-orders-changes>
      <h2 className="text-sm font-medium text-foreground">Changes</h2>
      <ol className="relative space-y-3 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-border">
        {list.map(c => (
          <li key={c.v} className="relative pl-6" data-orders-version={c.v}>
            <span className="absolute left-0 top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background ring-1 ring-border">
              <FileText className="w-2.5 h-2.5" />
            </span>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
                  <ActorBadge actor={c.by} />
                  <time dateTime={c.at} suppressHydrationWarning>
                    {fmtDateTime(c.at)}
                  </time>
                  {c.label && <span className="truncate max-w-[200px]">{c.label}</span>}
                </div>
                <p className="text-sm text-foreground mt-0.5 break-words">
                  v{c.v}
                  {c.undoOf ? ` · undo of v${c.undoOf}` : ''}
                  {c.need ? ` · proposal (Need #${c.need})` : ''}
                  {c.why && !(c.undoOf && c.why === `undo of v${c.undoOf}`) ? ` · ${c.why}` : ''}
                </p>
                {(c.removed.length > 0 || c.added.length > 0) && (
                  <div className="mt-1 space-y-0.5 font-mono text-xs break-words" data-orders-diff>
                    {c.removed.map((l, i) => (
                      <p key={`r${i}`} className="rounded px-1.5 py-0.5 bg-red-500/10 text-red-700 dark:text-red-300" data-diff="removed">
                        - {l}
                      </p>
                    ))}
                    {c.added.map((l, i) => (
                      <p key={`a${i}`} className="rounded px-1.5 py-0.5 bg-green-500/10 text-green-700 dark:text-green-300" data-diff="added">
                        + {l}
                      </p>
                    ))}
                  </div>
                )}
              </div>
              {history.canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => undo(c.v, c.v === history.version)}
                  title={c.v === history.version ? 'Put the text back as it was before this change' : 'Restore the text before this change'}
                  className="shrink-0 min-h-9 md:min-h-7"
                  data-orders-undo={c.v === history.version ? 'undo' : 'restore'}
                >
                  {c.v === history.version ? 'Undo' : 'Restore'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {history.log.length > SHOWN && (
        <button type="button" onClick={() => setAll(a => !a)} className="min-h-9 md:min-h-0 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2" data-orders-show-all>
          {all ? 'Show fewer' : `Show all ${history.log.length}`}
        </button>
      )}
    </section>
  );
}
