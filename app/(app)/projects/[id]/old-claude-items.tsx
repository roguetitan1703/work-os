import Link from '@/components/intent-link';
import { ChevronDown } from 'lucide-react';
import type { ClaudeItem } from '@/lib/types';

/** The project's old Claude items, read-only (they retired on 18 Nov; the work list is the State and the tasks). Shown only when the project has any. */
export function OldClaudeItems({ items, openRef }: { items: ClaudeItem[]; openRef?: number }) {
  if (!items.length) return null;
  return (
    <details open={openRef != null} data-card="old-claude-items" className="group rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden min-w-0">
      <summary className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-muted/60">
        <span className="text-[13px] md:text-xs font-semibold uppercase tracking-wider text-muted-foreground">Old Claude items</span>
        <span className="text-[13px] md:text-xs text-muted-foreground">{items.length}</span>
        <ChevronDown className="ml-auto w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180 shrink-0" />
      </summary>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {items.map(i => {
          const to = i.movedTo?.startsWith('#') ? i.movedTo : null;
          return (
            <li key={i.id} data-claude-item={`C${i.ref}`} className="px-4 md:px-3 py-2 min-h-11 md:min-h-9 text-[15px] md:text-sm min-w-0">
              <div className="flex items-start gap-2 min-w-0">
                <span className="font-mono text-xs text-muted-foreground shrink-0 mt-1">C{i.ref}</span>
                <span className="min-w-0 flex-1 break-words">{i.title}</span>
                <span className="text-[13px] md:text-xs text-muted-foreground shrink-0 mt-0.5">
                  {i.state === 'dropped' && i.movedTo ? (
                    to ? (
                      <>
                        now <Link href={`/tasks/${to.slice(1)}`} className="underline">{to}</Link>
                      </>
                    ) : (
                      'now a Later line'
                    )
                  ) : (
                    i.state
                  )}
                </span>
              </div>
              {i.why && <p className="mt-0.5 pl-7 text-[13px] md:text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-3">{i.why}</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
