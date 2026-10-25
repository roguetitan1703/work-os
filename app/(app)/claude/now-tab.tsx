'use client';

import { useState } from 'react';
import Link from '@/components/intent-link';
import { ChevronDown, ChevronRight, RotateCcw, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { cn } from '@/lib/utils';
import type { NeedsYouItem, SessionRow, SessionRowState, SessionSummary } from '@/lib/data/claude-overview';
import { removeSessionAction, resumeSessionAction, stopSessionAction, unhideSessionAction } from '../projects/[id]/launcher-actions';
import { updateClaudeItemAction } from '../projects/[id]/claude-items-actions';
import type { ClaudeTasks } from '@/lib/data/dispatcher';
import { write } from './auto-refresh';
import { dispatcherSettingsAction } from './dispatcher-actions';
import { ClaudeTasksSection } from './claude-tasks';
import { btnOutline, card, field, ghost, H2 } from './ui';

type Props = { needsYou: NeedsYouItem[]; sessions: SessionRow[]; summary: SessionSummary; hasComputers: boolean; claudeTasks: ClaudeTasks };

export function NowTab({ needsYou, sessions, summary, hasComputers, claudeTasks }: Props) {
  // Hide an answered row at once; it stays hidden until the server copy changes (a late refresh must not bring it back).
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const shown = needsYou.filter(i => answered[i.id] !== i.updatedAt);
  return (
    <div className="space-y-4">
      <SetupBanner hasComputers={hasComputers} enabled={claudeTasks.settings.enabled} hasNote={!!claudeTasks.settings.boilerplateNoteId} />
      <Summary summary={summary} needs={shown.length} hasComputers={hasComputers} />
      {shown.length > 0 && <NeedsYou items={shown} onAnswered={i => setAnswered(a => ({ ...a, [i.id]: i.updatedAt }))} />}
      <ClaudeTasksSection data={claudeTasks} />
      <Sessions sessions={sessions} hasComputers={hasComputers} />
    </div>
  );
}

// ── One banner for the state of Claude ──────────────────────────────────────

const banner = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-1.5 text-[15px] md:text-sm';

/** No computer: set up. A computer but Claude is switched off: switch it on (turning it on needs the note every session reads first, which is picked in Set up). Ready: nothing. */
function SetupBanner({ hasComputers, enabled, hasNote }: { hasComputers: boolean; enabled: boolean; hasNote: boolean }) {
  const [busy, setBusy] = useState(false);
  if (hasComputers && enabled) return null;
  if (!hasComputers)
    return (
      <p className={banner} data-claude-banner="no-computer">
        <span className="min-w-0 flex-1">Claude has no PC to work on.</span>
        <Link href="/claude?tab=setup" replace className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')}>
          Set up Claude
        </Link>
      </p>
    );
  if (!hasNote)
    return (
      <p className={banner} data-claude-banner="off">
        <span className="min-w-0 flex-1">Claude will not start tasks yet.</span>
        <Link href="/claude?tab=setup" replace className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} data-claude-switch-on>
          Switch on
        </Link>
      </p>
    );
  const switchOn = async () => {
    setBusy(true);
    try {
      const r = await write(() => dispatcherSettingsAction({ enabled: true }));
      if (!r.ok) return void toast.error(r.error);
      toast('Claude will start the tasks you give it');
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className={banner} data-claude-banner="off">
      <span className="min-w-0 flex-1">Claude will not start tasks yet.</span>
      <button type="button" className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} disabled={busy} onClick={switchOn} data-claude-switch-on>
        Switch on
      </button>
    </p>
  );
}

// ── Summary line ────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** "2m ago" style, short. */
export function agoShort(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Summary({ summary, needs, hasComputers }: { summary: SessionSummary; needs: number; hasComputers: boolean }) {
  const { computers } = summary;
  if (!hasComputers) return null;
  const many = computers.length > 1;
  const parts: { text: string; needs?: boolean }[] = [];
  if (summary.reporting === 0) {
    parts.push({ text: computers.length === 0 ? 'No news from your computers yet' : many ? 'No news from your computers' : `No news from ${computers[0].name}` });
  } else {
    parts.push({ text: many ? `${plural(summary.sessions, 'session')} on ${computers.length} computers` : `${plural(summary.sessions, 'session')} on ${computers[0].name}` });
    if (summary.subagents > 0) parts.push({ text: `${plural(summary.subagents, 'subagent')} working` });
  }
  if (needs > 0) parts.push({ text: `Claude is asking ${needs}`, needs: true });
  return (
    <section className="px-1 md:px-0 space-y-0.5" data-section="summary" aria-label="Claude activity on your computers">
      <p className="text-[16px] md:text-sm text-foreground font-medium" data-summary-line>
        {parts.map((p, n) => (
          <span key={n} className={cn(p.needs ? 'text-amber-700 dark:text-amber-300' : n > 0 && 'text-muted-foreground font-normal')}>
            {n > 0 && <span className="text-muted-foreground font-normal"> · </span>}
            {p.text}
          </span>
        ))}
      </p>
      {many && (
        <ul className="text-[13px] md:text-xs text-muted-foreground">
          {computers.map(c => (
            <li key={c.deviceId} data-summary-computer={c.name}>
              {c.fresh ? `${c.name}: ${plural(c.sessions, 'session')} · ${plural(c.subagents, 'subagent')} working` : `No news from ${c.name}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Claude is asking ─────────────────────────────────────────────────────

const FIRST = 3;

function NeedsYou({ items, onAnswered }: { items: NeedsYouItem[]; onAnswered: (i: NeedsYouItem) => void }) {
  const [open, setOpen] = useState<string | null>(null); // one expanded at a time
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, FIRST);
  return (
    <section className="space-y-1" data-section="needs-you">
      <h2 className={cn(H2, 'px-1 md:px-0 text-amber-700 dark:text-amber-300')}>Claude is asking {items.length}</h2>
      <ul className="rounded-xl border border-amber-500/30 bg-amber-500/5 divide-y divide-amber-500/20 overflow-hidden">
        {list.map(i => (
          <NeedsYouRow key={i.id} item={i} expanded={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} onAnswered={() => onAnswered(i)} />
        ))}
        {items.length > FIRST && (
          <li>
            <button type="button" onClick={() => setAll(v => !v)} className="w-full text-left px-3 h-11 md:h-8 text-[13px] font-medium text-muted-foreground hover:bg-amber-500/10" data-needs-more>
              {all ? 'Show fewer' : `${items.length - FIRST} more`}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function NeedsYouRow({ item: i, expanded, onToggle, onAnswered }: { item: NeedsYouItem; expanded: boolean; onToggle: () => void; onAnswered: () => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const text = reply.trim();

  // Plain flag, not useTransition (a transition stayed pending after the revalidation and froze the controls).
  const go = async (patch: { note?: string; waitingText?: string }, done: string, after: () => void) => {
    setBusy(true);
    try {
      const r = await write(() => updateClaudeItemAction(i.projectId, i.id, patch));
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

  // One question, one answer: the answer is stored with its question and Claude reads it in get_project
  // (claudeItems.answered). Closing without an answer tells Claude that too.
  const answer = () => go({ waitingText: '', note: text }, 'Answer sent. Claude sees it the next time it checks this project.', onAnswered);
  const closeIt = () => go({ waitingText: '' }, 'Closed without an answer', onAnswered);
  return (
    <li data-needs-you={`C${i.ref}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full flex items-start gap-2 px-3 min-h-11 md:min-h-8 text-left hover:bg-amber-500/10 active:bg-amber-500/15">
        {expanded ? <ChevronDown className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" />}
        <span className="text-[16px] md:text-[13px] min-w-0 py-2 md:py-1.5 break-words">
          <span className="font-semibold">{i.projectName}</span>
          <span className="font-mono text-muted-foreground"> · C{i.ref} · </span>
          <span className="text-foreground whitespace-pre-wrap">{i.question}</span>
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Link href={`/projects/${encodeURIComponent(i.projectId)}?claude=C${i.ref}`} className="inline-flex items-center min-h-11 md:min-h-6 text-[13px] text-muted-foreground underline">
            {i.title}
          </Link>
          <div className="flex items-center gap-2">
            <input
              className={cn(field, 'flex-1')}
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
    </li>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────

const STATE: Record<SessionRowState, { label: string; dot: string; tone: string }> = {
  working: { label: 'working', dot: 'bg-green-500 animate-pulse', tone: 'text-green-600 dark:text-green-400' },
  open: { label: 'open', dot: 'bg-green-500', tone: 'text-green-600 dark:text-green-400' },
  idle: { label: 'idle', dot: 'bg-sky-400', tone: 'text-sky-600 dark:text-sky-400' },
  starting: { label: 'starting', dot: 'bg-sky-500', tone: 'text-sky-600 dark:text-sky-400' },
  closed: { label: 'closed', dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' },
  stopped: { label: 'stopped', dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' },
  failed: { label: 'failed', dot: 'bg-red-500', tone: 'text-red-600 dark:text-red-400' },
  unknown: { label: 'no news', dot: 'bg-amber-500', tone: 'text-amber-600 dark:text-amber-400' },
};
const stateOf = (s: SessionRow) => (s.waiting ? { label: 'waiting at terminal', dot: 'bg-amber-500', tone: 'text-amber-600 dark:text-amber-400' } : STATE[s.state]);

function Sessions({ sessions, hasComputers }: { sessions: SessionRow[]; hasComputers: boolean }) {
  const [onlyWos, setOnlyWos] = useState(false);
  const [stopping, setStopping] = useState<SessionRow | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) => {
    setBusy(key);
    try {
      const r = await write(fn);
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      done?.();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const stop = (s: SessionRow) =>
    call(
      s.key,
      () => stopSessionAction(s.controlProjectId!, s.workOsId!),
      () => {
        toast(`Stopping ${s.title}…`);
        setStopping(null);
      },
    );
  const remove = (s: SessionRow) =>
    call(
      s.key,
      () => removeSessionAction(s.controlProjectId!, s.workOsId!),
      () => {
        setGone(g => new Set(g).add(s.key));
        toast('Removed from the list', {
          action: {
            label: 'Undo',
            onClick: () => {
              write(() => unhideSessionAction(s.controlProjectId!, s.workOsId!)).then(r => {
                if (!r.ok) return void toast.error(r.error);
                setGone(g => {
                  const n = new Set(g);
                  n.delete(s.key);
                  return n;
                });
              });
            },
          },
        });
      },
    );

  const visible = sessions.filter(s => !gone.has(s.key) && (!onlyWos || s.workOs));
  // Live first, then ended; each by last active (the server already sorted by last active).
  const ordered = [...visible].sort((a, b) => Number(b.live) - Number(a.live));
  const computers = [...new Set(ordered.map(s => s.deviceId))];
  const groups =
    computers.length > 1
      ? computers
          .map(id => ({ id, name: ordered.find(s => s.deviceId === id)!.deviceName, rows: ordered.filter(s => s.deviceId === id) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [{ id: 'all', name: '', rows: ordered }];

  const onResume = (s: SessionRow) =>
    call(
      s.key,
      () => resumeSessionAction(s.controlProjectId!, s.workOsId!),
      () => toast('Resuming…'),
    );

  if (!hasComputers && sessions.length === 0) return null; // the banner above says to set up first
  return (
    <section className="space-y-2" data-section="sessions">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className={cn(H2, 'px-1 md:px-0 text-muted-foreground')}>Sessions {ordered.length > 0 && ordered.length}</h2>
        <div role="group" aria-label="Filter sessions" className="inline-flex rounded-full md:rounded-md bg-muted/60 p-0.5">
          {(
            [
              [false, 'All sessions'],
              [true, 'Started from Work OS'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={onlyWos === v}
              onClick={() => setOnlyWos(v)}
              className={cn('h-11 md:h-8 px-3 rounded-full md:rounded-md text-[13px] font-medium whitespace-nowrap', onlyWos === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {ordered.length === 0 ? (
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">
          {onlyWos ? (
            'No sessions started from Work OS.'
          ) : (
            'No Claude Code sessions open right now.'
          )}
        </p>
      ) : (
        groups.map(g => (
          <div key={g.id} className="space-y-1" data-computer-group={g.name || undefined}>
            {g.name && <h3 className="px-1 md:px-0 text-[13px] md:text-xs font-semibold text-muted-foreground">{g.name}</h3>}
            <ul className={cn(card, 'divide-y divide-border/60')}>
              {g.rows.map(s => (
                <SessionLine key={s.key} s={s} busy={busy} onStop={setStopping} onRemove={remove} onResume={onResume} />
              ))}
            </ul>
          </div>
        ))
      )}
      {stopping && (
        <ConfirmSheet
          title="Stop session"
          message={
            <>
              Stop &ldquo;{stopping.title}&rdquo; in {stopping.folder} on {stopping.deviceName}? Its terminal closes; you can resume it later.
            </>
          }
          verb="Stop"
          danger
          pending={busy === stopping.key}
          onConfirm={() => stop(stopping)}
          onClose={() => setStopping(null)}
        />
      )}
    </section>
  );
}

function SessionLine({ s, busy, onStop, onRemove, onResume }: { s: SessionRow; busy: string | null; onStop: (s: SessionRow) => void; onRemove: (s: SessionRow) => void; onResume: (s: SessionRow) => void }) {
  const st = stateOf(s);
  const off = busy === s.key;
  const subs = s.subagents > 0 ? `${s.subagents} ${s.subagents === 1 ? 'subagent' : 'subagents'}` : '';
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1.5fr)_minmax(0,1fr)_6rem_8rem_5rem_10.5rem] items-center gap-x-2 pl-4 md:pl-3 pr-1 py-1 min-h-14 md:min-h-10"
      data-session-row={s.key}
      data-state={s.state}
    >
      <span aria-hidden className={cn('w-2.5 h-2.5 rounded-full shrink-0 mr-1', st.dot)} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[16px] md:text-sm font-medium text-foreground truncate" data-session-title>
            {s.title}
          </span>
          {s.workOs && <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-foreground/10 text-foreground font-medium">Work OS</span>}
        </div>
        {/* Phone: one meta line under the title. Desktop shows these as columns. */}
        <div className="md:hidden text-[13px] text-muted-foreground truncate" data-session-meta suppressHydrationWarning>
          <span className={st.tone}>{st.label}</span>
          {subs && ` · ${subs}`}
          {` · ${s.folder}`}
          {s.projectName && ` · ${s.projectName}`}
          {` · ${s.deviceName}`}
          <span suppressHydrationWarning>{` · ${agoShort(s.lastActiveAt)}`}</span>
          {s.error && ` · ${s.error}`}
        </div>
      </div>
      <div className="hidden md:block min-w-0 text-xs text-muted-foreground truncate" data-col="folder">
        {s.projectId ? (
          <Link href={`/projects/${encodeURIComponent(s.projectId)}`} className="hover:text-foreground">
            <span className="text-foreground">{s.projectName}</span> · {s.folder}
          </Link>
        ) : (
          s.folder
        )}
      </div>
      <div className="hidden md:block text-xs text-muted-foreground truncate" data-col="computer">
        {s.deviceName}
      </div>
      <div className="hidden md:block text-xs truncate" data-col="state">
        <span className={st.tone}>{st.label}</span>
        {subs && <span className="text-muted-foreground"> · {subs}</span>}
      </div>
      <div className="hidden md:block text-xs text-muted-foreground" data-col="ago" suppressHydrationWarning>
        <span suppressHydrationWarning>{agoShort(s.lastActiveAt)}</span>
      </div>
      <div className="flex items-center justify-end col-start-3 row-start-1 md:col-start-auto md:row-start-auto min-w-0">
        {s.canStop && (
          <button type="button" className={ghost} disabled={off} onClick={() => onStop(s)} aria-label={`Stop ${s.title}`}>
            <Square className="w-4 h-4" /> Stop
          </button>
        )}
        {s.canResume && (
          <button type="button" className={ghost} disabled={off} onClick={() => onResume(s)} aria-label={`Resume ${s.title}`}>
            <RotateCcw className="w-4 h-4" /> Resume
          </button>
        )}
        {s.canRemove && (
          <button type="button" className={ghost} disabled={off} onClick={() => onRemove(s)} aria-label={`Remove ${s.title}`}>
            <Trash2 className="w-4 h-4" /> Remove
          </button>
        )}
      </div>
    </li>
  );
}
