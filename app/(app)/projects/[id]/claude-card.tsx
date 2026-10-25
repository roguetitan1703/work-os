'use client';

import { Ago } from '@/components/ago';
import { useState } from 'react';
import Link from '@/components/intent-link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { cn } from '@/lib/utils';
import { sessionCan, stateText } from '@/lib/session-state';
import type { SessionView } from '@/lib/data/launcher';
import { btnOutline, field, ghost } from '@/app/(app)/claude/ui';
import { updateClaudeItemAction } from './claude-items-actions';
import { stopSessionAction } from './launcher-actions';

export type WaitingItem = { id: string; ref: number; title: string; question: string; updatedAt: string };
type Props = {
  projectId: string;
  tabHref: string;
  waiting: WaitingItem[];
  running: SessionView[];
  next: { ref: number; title: string } | null;
  queued: number;
  hasComputers: boolean;
};

const MAX_ROWS = 2;

/** Overview card: Claude is asking (the full question each), running sessions (one line each), the Next queue item. Compact on purpose. */
export function ClaudeCard({ projectId, tabHref, waiting, running, next, queued, hasComputers }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [stopping, setStopping] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = waiting.filter(w => answered[w.id] !== w.updatedAt);
  const rows = shown.slice(0, MAX_ROWS);

  const summary = [shown.length ? `Claude is asking ${shown.length}` : null, running.length ? `${running.length} running` : null, `${queued} queued`].filter(Boolean).join(' · ');

  const stop = async (s: SessionView) => {
    setBusy(true);
    try {
      const r = await stopSessionAction(projectId, s.id);
      if (!r.ok) return void toast.error(r.error);
      toast('Stopping…');
      setStopping(null);
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden" data-card="claude">
      <header className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9">
        <h2 className="text-[13px] md:text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude</h2>
        <span className={cn('text-[13px] md:text-xs truncate', shown.length ? 'text-amber-700 dark:text-amber-300 font-medium' : 'text-muted-foreground')}>{summary}</span>
        <Link href={tabHref} replace scroll={false} className="ml-auto h-11 md:h-9 px-1 inline-flex items-center text-[13px] md:text-xs text-muted-foreground hover:text-foreground shrink-0">
          See all ›
        </Link>
      </header>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {rows.map(w => (
          <WaitingRow
            key={w.id}
            projectId={projectId}
            item={w}
            expanded={open === w.id}
            onToggle={() => setOpen(open === w.id ? null : w.id)}
            onAnswered={() => {
              setAnswered(a => ({ ...a, [w.id]: w.updatedAt }));
              setOpen(null);
            }}
          />
        ))}
        {shown.length > MAX_ROWS && (
          <Link href={tabHref} replace scroll={false} className="flex items-center min-h-11 md:min-h-9 px-4 md:px-3 text-sm md:text-xs text-amber-700 dark:text-amber-300">
            {shown.length - MAX_ROWS} more ›
          </Link>
        )}
        {running.map(s => {
          const st = stateText(s);
          return (
            <div key={s.id} className="flex items-center gap-2 pl-4 md:pl-3 pr-1 min-h-11 md:min-h-9" data-session={s.id}>
              <span aria-hidden className={cn('w-2 h-2 rounded-full shrink-0', s.state === 'running' ? 'bg-green-500' : 'bg-amber-500')} />
              <div className="flex-1 min-w-0 text-[15px] md:text-sm truncate" suppressHydrationWarning>
                <span className="font-medium">{s.folderName}</span>
                <span className="text-muted-foreground">
                  {' '}· {s.deviceName} · <span className={st.tone}>{st.label}</span> · <Ago iso={s.startedAt} />
                </span>
              </div>
              {sessionCan(s).stop && (
                <button type="button" className={ghost} disabled={busy} onClick={() => setStopping(s)} aria-label={`Stop ${s.folderName} on ${s.deviceName}`}>
                  <Square className="w-4 h-4" /> Stop
                </button>
              )}
            </div>
          );
        })}
        {next ? (
          <div className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9 text-[15px] md:text-sm min-w-0" data-next>
            <span className="text-muted-foreground shrink-0">Next</span>
            <span className="font-mono text-xs shrink-0">C{next.ref}</span>
            <span className="truncate">{next.title}</span>
          </div>
        ) : (
          !shown.length &&
          !running.length && (
            <p className="px-4 md:px-3 min-h-11 md:min-h-9 flex items-center text-[15px] md:text-sm text-muted-foreground">
              {hasComputers ? 'Nothing waiting, nothing running.' : 'No computer added yet.'}
            </p>
          )
        )}
      </div>
      {stopping && (
        <ConfirmSheet
          title="Stop session"
          message={<>Stop the session in {stopping.folderName} on {stopping.deviceName}? Its terminal closes; you can resume it later.</>}
          verb="Stop"
          danger
          pending={busy}
          onConfirm={() => stop(stopping)}
          onClose={() => setStopping(null)}
        />
      )}
    </section>
  );
}

function WaitingRow({ projectId, item: i, expanded, onToggle, onAnswered }: { projectId: string; item: WaitingItem; expanded: boolean; onToggle: () => void; onAnswered: () => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const text = reply.trim();

  const go = async (patch: { note?: string; waitingText?: string }, done: string, after?: () => void) => {
    setBusy(true);
    try {
      const r = await updateClaudeItemAction(projectId, i.id, patch);
      if (!r.ok) return void toast.error(r.error);
      toast(done);
      setReply('');
      after?.();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  // One question, one answer: the answer is stored with its question and Claude reads it in get_project
  // (claudeItems.answered). Closing without an answer tells Claude that too.
  const answer = () => go({ waitingText: '', note: text }, 'Answer sent. Claude sees it the next time it checks this project.', onAnswered);
  const closeIt = () => go({ waitingText: '' }, 'Closed without an answer', onAnswered);
  return (
    <div data-needs-you={`C${i.ref}`} className="bg-amber-500/5">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full flex items-start gap-2 px-4 md:px-3 min-h-11 md:min-h-9 text-left">
        {expanded ? <ChevronDown className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" />}
        <span className="font-mono text-xs text-muted-foreground shrink-0 mt-3.5 md:mt-2.5">C{i.ref}</span>
        {!expanded && <span className="text-[15px] md:text-sm py-2.5 md:py-2 break-words whitespace-pre-wrap min-w-0">{i.question}</span>}
        {expanded && <span className="text-[13px] md:text-xs text-muted-foreground py-3 md:py-2.5 min-w-0 break-words">{i.title}</span>}
      </button>
      {expanded && (
        <div className="px-4 md:px-3 pb-3 space-y-2">
          <p className="text-[16px] md:text-sm whitespace-pre-wrap break-words">{i.question}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={cn(field, "flex-1 basis-full md:basis-0")}
              value={reply}
              maxLength={1000}
              onChange={e => setReply(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && text && !busy && void answer()}
              placeholder="Your answer…"
              aria-label={`Your answer to C${i.ref}`}
              enterKeyHint="send"
            />
            <button type="button" className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} disabled={busy || !text} onClick={answer}>
              Send answer
            </button>
            <button type="button" className="h-11 md:h-auto px-2 text-[13px] md:text-xs text-muted-foreground underline shrink-0 disabled:opacity-50" disabled={busy} onClick={closeIt}>
              Close without answer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
