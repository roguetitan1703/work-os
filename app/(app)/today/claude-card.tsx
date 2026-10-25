'use client';

import { useState } from 'react';
import Link from '@/components/intent-link';
import { ChevronDown, Play } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ClaudeOverview, NeedsYouItem } from '@/lib/data/claude-overview';
import { updateClaudeItemAction } from '../projects/[id]/claude-items-actions';

export type ClaudeCardData = { needsYou: NeedsYouItem[]; running: number; activity: ClaudeOverview['activity'] };

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const MAX_ROWS = 2;

/** Today's compact Claude card: one status line, up to two one-line questions (tap one to reply), activity counts. */
export function ClaudeCard({ data }: { data: ClaudeCardData | null }) {
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  const shown = data.needsYou.filter(i => answered[i.id] !== i.updatedAt);
  const rows = shown.slice(0, MAX_ROWS);
  const more = shown.length - rows.length;
  const { total, computers } = data.activity;
  const activity =
    computers.length === 0
      ? null
      : total.reporting === 0
        ? 'No news from your computers'
        : `${plural(total.sessions, 'Claude Code session')} · ${plural(total.subagents, 'subagent')} working`;

  return (
    <section data-section="claude-card" aria-label="Claude" className={cn('rounded-2xl md:rounded-lg border bg-card overflow-hidden', shown.length ? 'border-amber-500/40' : 'border-border/70 md:border-border')}>
      <div className="flex items-center gap-2 pl-4 md:pl-3 pr-2 min-h-[52px] md:min-h-11">
        <p className="flex-1 min-w-0 text-[15px] md:text-sm text-foreground" data-claude-status>
          {shown.length ? <span className="font-semibold text-amber-700 dark:text-amber-300">{shown.length} needs you</span> : <span className="text-muted-foreground">Nothing waiting</span>}
          <span className="text-muted-foreground"> · </span>
          <Link href="/claude" className="inline-flex items-center min-h-11 md:min-h-0 text-muted-foreground hover:text-foreground">
            {data.running} running ›
          </Link>
        </p>
        <Link
          href="/today?start=1"
          scroll={false}
          data-start-claude
          className="h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center gap-1.5 bg-foreground text-background shrink-0"
        >
          <Play className="w-4 h-4" /> Start Claude
          <kbd className="hidden md:inline ml-1 text-[10px] font-mono border border-background/40 rounded px-1">S</kbd>
        </Link>
      </div>
      {rows.length > 0 && (
        <ul className="border-t border-border/60 divide-y divide-border/60">
          {rows.map(i => (
            <Row
              key={i.id}
              item={i}
              open={open === i.id}
              onToggle={() => setOpen(o => (o === i.id ? null : i.id))}
              onAnswered={() => {
                setAnswered(a => ({ ...a, [i.id]: i.updatedAt }));
                setOpen(null);
              }}
            />
          ))}
        </ul>
      )}
      {(more > 0 || activity) && (
        <div className="flex items-center justify-between gap-2 px-4 md:px-3 min-h-9 text-[13px] md:text-xs text-muted-foreground border-t border-border/60">
          {activity && (
            <p className="min-w-0 truncate" data-activity-total>
              {activity}
            </p>
          )}
          {more > 0 && (
            <Link href="/claude" className="ml-auto shrink-0 inline-flex items-center min-h-11 md:min-h-0 font-medium text-foreground">
              {more} more ›
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ item: i, open, onToggle, onAnswered }: { item: NeedsYouItem; open: boolean; onToggle: () => void; onAnswered: () => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const text = reply.trim();
  const go = async (patch: { note?: string; waitingText?: string }, done: string, after: () => void) => {
    setBusy(true);
    try {
      const r = await updateClaudeItemAction(i.projectId, i.id, patch);
      if (!r.ok) return void toast.error(r.error);
      toast(done);
      setReply('');
      after();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  const btn = 'h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold shrink-0 border border-border bg-card hover:bg-muted/60 active:bg-muted disabled:opacity-50';
  // One question, one answer: the answer is stored with its question and Claude reads it in get_project
  // (claudeItems.answered). Closing without an answer tells Claude that too.
  const answer = () => go({ waitingText: '', note: text }, 'Answer sent. Claude sees it the next time it checks this project.', onAnswered);
  const closeIt = () => go({ waitingText: '' }, 'Closed without an answer', onAnswered);
  return (
    <li data-needs-you={`C${i.ref}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full min-h-11 flex items-center gap-2 pl-4 md:pl-3 pr-3 text-left active:bg-muted/50 hover:bg-muted/30">
        <span className="min-w-0 flex-1 truncate text-[15px] md:text-sm text-foreground">
          <span className="font-semibold">{i.projectName}</span> <span className="font-mono text-muted-foreground">C{i.ref}</span> <span className="text-muted-foreground">·</span> {i.question}
        </span>
        <ChevronDown className={cn('w-4 h-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 md:px-3 pb-3 space-y-2">
          <p className="text-[16px] md:text-sm text-foreground whitespace-pre-wrap break-words">{i.question}</p>
          <Link href={`/projects/${encodeURIComponent(i.projectId)}?claude=C${i.ref}`} className="inline-flex items-center min-h-11 md:min-h-0 text-[13px] md:text-xs text-muted-foreground underline">
            {i.title}
          </Link>
          <div className="flex items-center gap-2">
            <input
              className="w-full min-w-0 flex-1 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring"
              value={reply}
              maxLength={1000}
              onChange={e => setReply(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && text && !busy && void answer()}
              placeholder="Your answer…"
              aria-label={`Your answer to C${i.ref}`}
              enterKeyHint="send"
            />
            <button type="button" className={cn(btn, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} disabled={busy || !text} onClick={answer}>
              Send answer
            </button>
            <button type="button" className="h-11 md:h-auto px-2 text-[13px] md:text-xs text-muted-foreground underline shrink-0 disabled:opacity-50" disabled={busy} onClick={closeIt}>
              Close without answer
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
