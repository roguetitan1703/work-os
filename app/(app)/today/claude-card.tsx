'use client';

import Link from '@/components/intent-link';
import { Play } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { SessionList } from '@/components/session-row';
import type { SessionItem, SessionsView } from '@/lib/session-item';
import type { Need } from '@/lib/data/needs';

/** The same sessions the Claude page lists (lib/session-item.ts): its counts and the first live ones. */
export type ClaudeCardData = { hasComputers: boolean; counts: SessionsView['counts']; live: SessionItem[]; tz: string; subagents: number; asks?: Record<string, Need> };

/** How many live sessions the card shows; the rest are on the Claude page. */
const SHOWN = 3;

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Today's Claude card: one status line (the Claude page's counts), the first live sessions, Start Claude. */
export function ClaudeCard({ data }: { data: ClaudeCardData | null }) {
  if (!data) return null;
  const { counts } = data;
  const parts = [
    counts.live ? plural(counts.live, 'session') : 'No session running',
    counts.working ? `${counts.working} working` : '',
    counts.waiting ? `${counts.waiting} waiting` : '',
    counts.finished ? `${counts.finished} finished today` : '',
  ].filter(Boolean);
  return (
    <Card as="section" data-section="claude-card" aria-label="Claude">
      <div className="flex items-center gap-2 pl-4 pr-2 min-h-row py-1">
        <p className="flex-1 min-w-0 text-body md:text-meta text-muted-foreground" data-claude-status>
          <Link href="/claude" className="inline-flex items-center min-h-11 md:min-h-0 hover:text-foreground">
            <span className="font-medium text-foreground">Claude</span>
            <span>&nbsp;· {parts.join(' · ')} ›</span>
          </Link>
        </p>
        {data.hasComputers ? (
          <Link
            href="/today?start=1"
            scroll={false}
            data-start-claude
            className="h-11 md:h-9 px-4 rounded-pill text-meta font-semibold inline-flex items-center gap-1.5 bg-foreground text-background shrink-0"
          >
            <Play className="w-4 h-4" /> Start Claude
            <kbd className="hidden md:inline ml-1 text-label font-mono border border-background/40 rounded px-1">S</kbd>
          </Link>
        ) : (
          <Link href="/claude?tab=setup" data-set-up-claude className="h-11 md:h-9 px-4 rounded-pill text-meta font-semibold inline-flex items-center gap-1.5 bg-foreground text-background shrink-0">
            Set up Claude
          </Link>
        )}
      </div>
      {data.live.length > 0 && (
        <div className="border-t border-border/60">
          <SessionList items={data.live.slice(0, SHOWN)} tz={data.tz} where="today" asks={data.asks} className="rounded-none border-0" />
        </div>
      )}
      {data.subagents > 0 && (
        <p className="px-4 min-h-9 flex items-center text-meta text-muted-foreground border-t border-border/60" data-activity-total>
          {plural(data.subagents, 'subagent')} working
        </p>
      )}
    </Card>
  );
}
