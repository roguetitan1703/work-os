'use client';

import Link from '@/components/intent-link';
import { Play } from 'lucide-react';
import type { ClaudeOverview } from '@/lib/data/claude-overview';

export type ClaudeCardData = { hasComputers: boolean; running: number; activity: ClaudeOverview['activity'] };

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Today's compact Claude card: one status line and activity counts. */
export function ClaudeCard({ data }: { data: ClaudeCardData | null }) {
  if (!data) return null;
  const { total, computers } = data.activity;
  const activity =
    computers.length === 0
      ? null
      : total.reporting === 0
        ? 'No news from your computers'
        : `${plural(total.sessions, 'Claude Code session')} · ${plural(total.subagents, 'subagent')} working`;

  return (
    <section data-section="claude-card" aria-label="Claude" className={'rounded-2xl md:rounded-lg border bg-card overflow-hidden border-border/70 md:border-border'}>
      <div className="flex items-center gap-2 pl-4 md:pl-3 pr-2 min-h-[52px] md:min-h-11">
        <p className="flex-1 min-w-0 text-[15px] md:text-sm text-foreground" data-claude-status>
          <span className="text-muted-foreground">{data.running ? 'Claude is working' : 'Claude is idle'}</span>
          <span className="text-muted-foreground"> · </span>
          <Link href="/claude" className="inline-flex items-center min-h-11 md:min-h-0 text-muted-foreground hover:text-foreground">
            {data.running} running ›
          </Link>
        </p>
        {data.hasComputers ? (
          <Link
            href="/today?start=1"
            scroll={false}
            data-start-claude
            className="h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center gap-1.5 bg-foreground text-background shrink-0"
          >
            <Play className="w-4 h-4" /> Start Claude
            <kbd className="hidden md:inline ml-1 text-[10px] font-mono border border-background/40 rounded px-1">S</kbd>
          </Link>
        ) : (
          <Link
            href="/claude?tab=setup"
            data-set-up-claude
            className="h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center gap-1.5 bg-foreground text-background shrink-0"
          >
            Set up Claude
          </Link>
        )}
      </div>
      {activity && (
        <div className="flex items-center justify-between gap-2 px-4 md:px-3 min-h-9 text-[13px] md:text-xs text-muted-foreground border-t border-border/60">
          <p className="min-w-0 truncate" data-activity-total>
            {activity}
          </p>
        </div>
      )}
    </section>
  );
}
