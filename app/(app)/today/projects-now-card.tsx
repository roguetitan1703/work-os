import Link from '@/components/intent-link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { oneSentence } from '@/lib/format';
import type { ProjectNowRow } from '@/lib/data/today-projects';

/**
 * Today's "Projects now": one row per project that has a session in a lane, a Need waiting on me or one of my open tasks.
 * Each row is the project's Now (one sentence), its first Next line, "N sessions" and an amber dot while a Need waits.
 * Looks like the Needs you section above it; the card is hidden when there is nothing to show.
 */
export function ProjectsNowCard({ rows, phone }: { rows: ProjectNowRow[]; phone: boolean }) {
  if (!rows.length) return null;
  return (
    <section data-section="projects-now" className={phone ? 'mt-3' : ''}>
      <h2 className={cn('font-semibold uppercase tracking-wider text-muted-foreground', phone ? 'px-1 mb-1.5 text-[13px]' : 'mb-1.5 text-xs')}>Projects now</h2>
      <div className={cn('border bg-card overflow-hidden divide-y divide-border/60', phone ? 'rounded-2xl border-border/70' : 'rounded-lg border-border')}>
        {rows.map(r => (
          <Link
            key={r.id}
            href={`/projects/${r.id}`}
            data-project-row={r.id}
            className={cn('flex items-center gap-3 hover:bg-muted/40 active:bg-muted/60 transition-colors', phone ? 'px-4 py-3 min-h-[52px]' : 'px-3 py-2.5')}
          >
            <div className="min-w-0 flex-1">
              <div className={cn('flex items-center gap-2 min-w-0 text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>
                <span className="truncate font-medium text-foreground">{r.name}</span>
                {r.need && <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" data-project-need role="img" aria-label="A Need waits on you" />}
                {r.sessions > 0 && <span className="shrink-0" data-project-sessions>· {r.sessions} {r.sessions === 1 ? 'session' : 'sessions'}</span>}
              </div>
              <p className={cn('text-foreground leading-snug truncate', phone ? 'text-[15px]' : 'text-sm', !r.now && 'text-muted-foreground')} data-project-row-now title={r.now ?? undefined}>
                {r.now ? oneSentence(r.now) : 'No goal set yet'}
              </p>
              {r.next && (
                <p className={cn('text-muted-foreground truncate', phone ? 'text-[13px]' : 'text-xs')} data-project-row-next>
                  Next: {r.next}
                </p>
              )}
            </div>
            <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </div>
    </section>
  );
}
