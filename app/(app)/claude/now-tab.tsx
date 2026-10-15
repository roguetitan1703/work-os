'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, RotateCcw, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sessionCan, stateText } from '@/lib/session-state';
import type { NeedsYouItem, OverviewSession } from '@/lib/data/claude-overview';
import { removeSessionAction, resumeSessionAction, stopSessionAction, unhideSessionAction } from '../projects/[id]/launcher-actions';
import { updateClaudeItemAction } from '../projects/[id]/claude-items-actions';
import { btnOutline, card, field, ghost, H2 } from './ui';

type Props = { needsYou: NeedsYouItem[]; running: OverviewSession[]; recent: OverviewSession[]; hasComputers: boolean };

export function NowTab({ needsYou, running, recent, hasComputers }: Props) {
  return (
    <div className="space-y-5 md:space-y-0 md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:gap-6 md:items-start">
      <NeedsYou items={needsYou} />
      <div className="space-y-5">
        <Running sessions={running} hasComputers={hasComputers} />
        <Recent sessions={recent} />
      </div>
    </div>
  );
}

// ── Needs you ───────────────────────────────────────────────────────────────

function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  // Hide an answered row at once; it stays hidden until the server copy changes (a late refresh must not bring it back).
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const shown = items.filter(i => answered[i.id] !== i.updatedAt);
  return (
    <section className="space-y-2" data-section="needs-you">
      <h2 className={cn(H2, 'px-1 md:px-0', shown.length ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>Needs you {shown.length > 0 && shown.length}</h2>
      {shown.length === 0 ? (
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">Nothing waiting on you.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map(i => (
            <NeedsYouRow key={i.id} item={i} onAnswered={() => setAnswered(a => ({ ...a, [i.id]: i.updatedAt }))} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NeedsYouRow({ item: i, onAnswered }: { item: NeedsYouItem; onAnswered: () => void }) {
  const router = useRouter();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const text = reply.trim();

  // Plain flag, not useTransition (a transition stayed pending after the revalidation and froze the controls).
  const go = async (patch: { note?: string; waitingOnOm?: string }, done: string, after: () => void) => {
    setBusy(true);
    try {
      const r = await updateClaudeItemAction(i.projectId, i.id, patch);
      if (!r.ok) return void toast.error(r.error);
      toast(done);
      setReply('');
      after();
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  const sendReply = () => go({ note: text }, 'Reply saved', () => {});

  return (
    <li className={cn(card, 'border-amber-500/30 bg-amber-500/5 px-4 md:px-3 py-3 md:py-2.5 space-y-2')} data-needs-you={`C${i.ref}`}>
      <Link href={`/projects/${encodeURIComponent(i.projectId)}?claude=C${i.ref}`} className="flex items-baseline gap-2 min-h-6 text-[13px] md:text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{i.projectName}</span>
        <span className="font-mono">C{i.ref}</span>
        <span className="truncate">{i.title}</span>
      </Link>
      <p className="text-[16px] md:text-sm text-foreground whitespace-pre-wrap break-words">{i.question}</p>
      <div className="flex items-center gap-2">
        <input
          className={cn(field, 'flex-1')}
          value={reply}
          maxLength={1000}
          onChange={e => setReply(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && text && !busy && void sendReply()}
          placeholder="Reply…"
          aria-label={`Reply to C${i.ref}`}
          enterKeyHint="send"
        />
        <button type="button" className={btnOutline} disabled={busy || !text} onClick={sendReply}>
          Reply
        </button>
        <button type="button" className={btnOutline} disabled={busy} onClick={() => go({ waitingOnOm: '', ...(text ? { note: text } : {}) }, 'Marked answered', onAnswered)}>
          Answered
        </button>
      </div>
    </li>
  );
}

// ── Running ─────────────────────────────────────────────────────────────────

function Running({ sessions, hasComputers }: { sessions: OverviewSession[]; hasComputers: boolean }) {
  const router = useRouter();
  const [stopping, setStopping] = useState<OverviewSession | null>(null);
  const [busy, setBusy] = useState(false);

  const stop = async (s: OverviewSession) => {
    setBusy(true);
    try {
      const r = await stopSessionAction(s.projectId, s.id);
      if (!r.ok) return void toast.error(r.error);
      toast(`Stopping ${s.projectName}…`);
      setStopping(null);
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-section="running">
      <h2 className={cn(H2, 'px-1 md:px-0 text-muted-foreground')}>Running {sessions.length > 0 && sessions.length}</h2>
      {sessions.length === 0 ? (
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">
          {hasComputers ? (
            'No sessions running.'
          ) : (
            <>
              No computer added yet. Add one under{' '}
              <Link href="/claude?tab=setup" replace className="underline">
                Setup
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <div className={cn(card, 'divide-y divide-border/60')}>
          {sessions.map(s => {
            const st = stateText(s);
            return (
              <div key={s.id} className="flex items-center gap-1 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-session={s.id}>
                <span aria-hidden className={cn('w-2.5 h-2.5 rounded-full shrink-0 mr-1', s.state === 'running' ? 'bg-green-500' : s.state === 'unknown' || s.waiting ? 'bg-amber-500' : 'bg-sky-500')} />
                <div className="flex-1 min-w-0">
                  <div className="text-[16px] md:text-sm text-foreground truncate">
                    <span className="font-medium">{s.projectName}</span> <span className="text-muted-foreground">· {s.folderName} · {s.deviceName}</span>
                  </div>
                  <div className="text-[13px] md:text-xs" suppressHydrationWarning>
                    <span className={st.tone}>{st.label}</span>
                    <span className="text-muted-foreground" suppressHydrationWarning> · started {fmtAgo(s.startedAt)}</span>
                  </div>
                </div>
                {sessionCan(s).stop && (
                  <button type="button" className={ghost} disabled={busy} onClick={() => setStopping(s)} aria-label={`Stop ${s.projectName} on ${s.deviceName}`}>
                    <Square className="w-4 h-4" /> Stop
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {stopping && (
        <ConfirmSheet
          title="Stop session"
          message={
            <>
              Stop the {stopping.projectName} session in {stopping.folderName} on {stopping.deviceName}? Its terminal closes; you can resume it later.
            </>
          }
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

// ── Recent ──────────────────────────────────────────────────────────────────

function Recent({ sessions }: { sessions: OverviewSession[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const shown = sessions.filter(s => !gone.has(s.id));

  const call = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) => {
    setBusy(id);
    try {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      done?.();
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const remove = (s: OverviewSession) =>
    call(
      s.id,
      () => removeSessionAction(s.projectId, s.id),
      () => {
        setGone(g => new Set(g).add(s.id));
        toast('Removed from the list', {
          action: {
            label: 'Undo',
            onClick: () => {
              unhideSessionAction(s.projectId, s.id).then(r => {
                if (!r.ok) return void toast.error(r.error);
                setGone(g => {
                  const n = new Set(g);
                  n.delete(s.id);
                  return n;
                });
                router.refresh();
              });
            },
          },
        });
      },
    );

  return (
    <section className="space-y-2" data-section="recent">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className={cn(H2, 'flex items-center gap-1 min-h-11 md:min-h-0 px-1 md:px-0 text-muted-foreground')}>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Recent {shown.length > 0 && shown.length}
      </button>
      {open &&
        (shown.length === 0 ? (
          <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">Nothing recent.</p>
        ) : (
          <div className={cn(card, 'divide-y divide-border/60')}>
            {shown.map(s => {
              const st = stateText(s);
              const can = sessionCan(s);
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-1 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-session={s.id}>
                  <div className="flex-1 basis-40 min-w-0">
                    <div className="text-[16px] md:text-sm text-foreground truncate">
                      <span className="font-medium">{s.projectName}</span> <span className="text-muted-foreground">· {s.folderName} · {s.deviceName}</span>
                    </div>
                    <div className="text-[13px] md:text-xs" suppressHydrationWarning>
                      <span className={st.tone}>{st.label}</span>
                      <span className="text-muted-foreground" suppressHydrationWarning> · {fmtAgo(s.updatedAt)}</span>
                      {s.error && <span className="text-muted-foreground"> · {s.error}</span>}
                    </div>
                  </div>
                  {can.resume && (
                    <button type="button" className={ghost} disabled={busy === s.id} onClick={() => call(s.id, () => resumeSessionAction(s.projectId, s.id), () => toast('Resuming…'))} aria-label={`Resume ${s.projectName}`}>
                      <RotateCcw className="w-4 h-4" /> Resume
                    </button>
                  )}
                  {can.remove && (
                    <button type="button" className={ghost} disabled={busy === s.id} onClick={() => remove(s)} aria-label={`Remove ${s.projectName}`}>
                      <Trash2 className="w-4 h-4" /> Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}
