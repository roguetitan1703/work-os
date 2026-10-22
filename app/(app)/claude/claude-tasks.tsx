'use client';

import { useState } from 'react';
import Link from '@/components/intent-link';
import { Square, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { cn } from '@/lib/utils';
import type { ClaudeTaskRow, ClaudeTasks } from '@/lib/data/dispatcher';
import { write } from './auto-refresh';
import { takeBackFromClaudeAction } from './dispatcher-actions';
import { agoShort } from './now-tab';
import { card, ghost, H2 } from './ui';

// "Claude's tasks" (docs/dispatcher.md): the tasks you gave to Claude. Running, then queued in the
// order they will start, then recently finished or stopped. Compact rows, same look as Sessions.

const STATE: Record<ClaudeTaskRow['state'], { label: string; dot: string; tone: string }> = {
  running: { label: 'working', dot: 'bg-green-500 animate-pulse', tone: 'text-green-600 dark:text-green-400' },
  queued: { label: 'queued', dot: 'bg-sky-400', tone: 'text-sky-600 dark:text-sky-400' },
  finished: { label: 'finished', dot: 'bg-green-500', tone: 'text-green-600 dark:text-green-400' },
  stopped: { label: 'stopped', dot: 'bg-amber-500', tone: 'text-amber-600 dark:text-amber-400' },
  failed: { label: 'could not start', dot: 'bg-red-500', tone: 'text-red-600 dark:text-red-400' },
};

export function ClaudeTasksSection({ data }: { data: ClaudeTasks }) {
  const [confirm, setConfirm] = useState<{ row: ClaudeTaskRow; stop: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const { settings, running, queued, recent } = data;
  const total = running.length + queued.length;

  const go = async (row: ClaudeTaskRow, stop: boolean) => {
    setBusy(row.ref);
    try {
      const r = await write(() => takeBackFromClaudeAction(String(row.ref), stop));
      if (!r.ok) return void toast.error(r.error);
      toast(stop ? `Stopping Claude on #${row.ref}` : `#${row.ref} taken back`);
      setConfirm(null);
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const group = (label: string, rows: ClaudeTaskRow[]) =>
    rows.length > 0 && (
      <div className="space-y-1" data-claude-group={label}>
        <h3 className="px-1 md:px-0 text-[13px] md:text-xs font-semibold text-muted-foreground">{label}</h3>
        <ul className={cn(card, 'divide-y divide-border/60')}>
          {rows.map(r => (
            <Line key={r.ref} r={r} busy={busy === r.ref} onAct={() => setConfirm({ row: r, stop: r.state === 'running' })} />
          ))}
        </ul>
      </div>
    );

  return (
    <section className="space-y-2" data-section="claude-tasks">
      <h2 className={cn(H2, 'px-1 md:px-0 text-muted-foreground')}>Claude&apos;s tasks {total > 0 && total}</h2>
      {!settings.enabled && (
        <p className="text-[15px] md:text-sm rounded-xl bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2" data-dispatcher-off>
          The dispatcher is off, so nothing starts.{' '}
          <Link href="/claude?tab=setup" replace className="underline">
            Turn it on in Setup
          </Link>
          .
        </p>
      )}
      {total === 0 && recent.length === 0 ? (
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0" data-claude-tasks-empty>
          Nothing given to Claude. Open a task and choose <b>Give to Claude</b>.
        </p>
      ) : (
        <div className="space-y-2">
          {group(`Working ${running.length} of ${settings.maxConcurrent}`, running)}
          {group('Queued, in order', queued)}
          {group('Recently finished or stopped', recent)}
        </div>
      )}
      {confirm && (
        <ConfirmSheet
          title={confirm.stop ? 'Stop Claude' : 'Take back'}
          message={
            confirm.stop ? (
              <>Stop Claude on #{confirm.row.ref} {confirm.row.title}? Its session closes. The task stays In Progress; work so far stays in the folder.</>
            ) : (
              <>Take #{confirm.row.ref} {confirm.row.title} back from Claude? It has not started.</>
            )
          }
          verb={confirm.stop ? 'Stop and take back' : 'Take back'}
          danger={confirm.stop}
          pending={busy === confirm.row.ref}
          onConfirm={() => go(confirm.row, confirm.stop)}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}

function Line({ r, busy, onAct }: { r: ClaudeTaskRow; busy: boolean; onAct: () => void }) {
  const st = STATE[r.state];
  const when = r.state === 'running' ? r.lastActiveAt ?? r.claimedAt : r.state === 'queued' ? r.markedAt : r.endedAt;
  const meta = [
    r.state === 'queued' && r.position ? `#${r.position} in line` : st.label,
    r.projectName,
    r.deviceName,
    r.state === 'running' ? (when ? `active ${agoShort(when)}` : 'starting') : agoShort(when),
    r.note && r.state !== 'running' ? r.note : null,
  ].filter(Boolean);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 pl-4 md:pl-3 pr-1 py-1 min-h-14 md:min-h-10" data-claude-task={r.ref} data-state={r.state}>
      <span aria-hidden className={cn('w-2.5 h-2.5 rounded-full shrink-0 mr-1', st.dot)} />
      <div className="min-w-0">
        <Link href={`/tasks/${r.ref}`} className="block text-[16px] md:text-sm font-medium text-foreground truncate hover:underline">
          <span className="font-mono text-muted-foreground font-normal">#{r.ref}</span> {r.title}
        </Link>
        <div className="text-[13px] md:text-xs text-muted-foreground truncate" suppressHydrationWarning>
          <span className={st.tone}>{meta[0]}</span>
          {meta.slice(1).map((m, i) => (
            <span key={i} suppressHydrationWarning>{` · ${m}`}</span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end min-w-0">
        {r.state === 'running' && (
          <button type="button" className={ghost} disabled={busy} onClick={onAct} aria-label={`Stop Claude on #${r.ref}`}>
            <Square className="w-4 h-4" /> Stop
          </button>
        )}
        {r.state === 'queued' && (
          <button type="button" className={ghost} disabled={busy} onClick={onAct} aria-label={`Take back #${r.ref}`}>
            <Undo2 className="w-4 h-4" /> Take back
          </button>
        )}
      </div>
    </li>
  );
}
