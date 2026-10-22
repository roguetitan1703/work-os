'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Bot, ExternalLink, X } from 'lucide-react';
import { claudeMenuLabel } from '../give-to-claude';
import { updateTaskAction } from '@/app/actions';
import { addDays } from '@/lib/dates';
import { fmtDue } from '@/lib/format';
import type { Priority, Status, Task, TaskPatch } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp, useModes } from '../app-context';

const STATUS_OPTS: { s: Status; label: string; on: string }[] = [
  { s: 'Not Started', label: 'To do', on: 'bg-foreground text-background border-foreground' },
  { s: 'In Progress', label: 'In progress', on: 'bg-blue-500 text-white border-blue-500' },
  { s: 'Blocked', label: 'Blocked', on: 'bg-red-500 text-white border-red-500' },
  { s: 'Done', label: 'Done', on: 'bg-green-500 text-white border-green-500' },
  { s: 'Dropped', label: 'Dropped', on: 'bg-muted-foreground text-background border-muted-foreground' },
];
const PRIO_OPTS: { p: Priority; on: string }[] = [
  { p: 'P1', on: 'bg-red-500 text-white border-red-500' },
  { p: 'P2', on: 'bg-orange-500 text-white border-orange-500' },
  { p: 'P3', on: 'bg-yellow-500 text-white border-yellow-500' },
  { p: 'P4', on: 'bg-foreground text-background border-foreground' },
];

/** Phone quick-edit sheet for one task: status, priority, due, mode. Reuses updateTaskAction. */
export function TaskActionSheet({ task, open, onClose, onClaude }: { task: Task; open: boolean; onClose: () => void; onClaude?: () => void }) {
  const { today } = useApp();
  const { modes, color } = useModes();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState(task.blockedReason ?? '');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  function apply(patch: TaskPatch, msg: string) {
    navigator.vibrate?.(10);
    start(async () => {
      const res = await updateTaskAction(task.id, patch);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`#${task.ref} ${msg}`);
      onClose();
      router.refresh();
    });
  }

  const dues = [
    { label: 'Today', v: today },
    { label: 'Tomorrow', v: addDays(today, 1) },
    { label: 'In a week', v: addDays(today, 7) },
  ];

  // Portalled to <body>: inside <main> (z-10) the tab bar (z-40) would draw over the sheet's bottom edge.
  return createPortal(
    <div className="md:hidden fixed inset-0 z-50" data-sheet>
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />
      <div
        className={cn('absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-background shadow-2xl animate-in slide-in-from-bottom duration-200', pending && 'opacity-70')}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="mx-auto mt-2.5 mb-1 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        <div className="flex items-start gap-2 px-4 pt-1">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-mono text-muted-foreground">#{task.ref}</div>
            <div className="text-[17px] font-semibold leading-snug text-foreground">{task.title}</div>
          </div>
          <button onClick={onClose} className="w-11 h-11 -mr-2 -mt-1 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <Group label="Status" cols="grid-cols-2">
          {STATUS_OPTS.map(o => (
            <Opt key={o.s} on={task.status === o.s} tone={o.on} onClick={() => {
                if (task.status === o.s) return;
                if (o.s === 'Blocked') setAsking(true);
                else apply({ status: o.s }, `→ ${o.label}`);
              }}>
              {o.label}
            </Opt>
          ))}
        </Group>
        {asking && (
          <div className="mx-4 mt-3 rounded-2xl border border-red-500/40 bg-red-500/5 p-3">
            <label className="text-[12px] font-semibold text-red-600 dark:text-red-400">What is it blocked on?</label>
            <textarea
              autoFocus
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="Reason"
              className="mt-1 w-full resize-none rounded-xl border border-input bg-background p-2 text-[16px] outline-none"
            />
            <div className="mt-2 flex gap-2">
              <button onClick={() => setAsking(false)} className="h-11 px-4 rounded-xl border border-border text-sm font-medium">
                Cancel
              </button>
              <button
                disabled={!reason.trim()}
                onClick={() => apply({ status: 'Blocked', blockedReason: reason.trim() }, '→ Blocked')}
                className="flex-1 h-11 rounded-xl bg-red-500 text-white text-sm font-semibold disabled:opacity-40"
              >
                Mark blocked
              </button>
            </div>
          </div>
        )}
        <Group label="Priority" cols="grid-cols-4">
          {PRIO_OPTS.map(o => (
            <Opt key={o.p} on={task.priority === o.p} tone={o.on} onClick={() => task.priority !== o.p && apply({ priority: o.p }, `→ ${o.p}`)}>
              {o.p}
            </Opt>
          ))}
        </Group>
        <Group label={`Due${task.due ? ` · ${fmtDue(task.due, today)}` : ''}`}>
          {dues.map(d => (
            <Opt key={d.label} on={task.due === d.v} onClick={() => task.due !== d.v && apply({ due: d.v }, `due ${d.label.toLowerCase()}`)}>
              {d.label}
            </Opt>
          ))}
          <label className="shrink-0 h-11 px-3.5 rounded-full border border-border text-sm font-medium flex items-center gap-2 text-foreground">
            Pick
            <input
              type="date"
              value={task.due ?? ''}
              onChange={e => e.target.value && apply({ due: e.target.value }, `due ${e.target.value}`)}
              className="bg-transparent text-[16px] outline-none w-[8.5rem]"
            />
          </label>
          {task.due && <Opt onClick={() => apply({ due: null }, 'due cleared')}>No date</Opt>}
        </Group>
        <Group label="Mode">
          {modes.map(m => (
            <Opt key={m.name} on={task.mode === m.name} onClick={() => apply({ mode: task.mode === m.name ? null : m.name }, task.mode === m.name ? 'mode cleared' : `→ ${m.name}`)}>
              {m.name}
            </Opt>
          ))}
        </Group>

        <div className="px-4 pt-4 space-y-2">
          {onClaude && task.status !== 'Done' && task.status !== 'Dropped' && (
            <button type="button" onClick={onClaude} data-claude-menu className="w-full h-12 rounded-2xl border border-border flex items-center justify-center gap-2 text-[15px] font-medium text-foreground active:bg-muted">
              <Bot className="w-4 h-4" /> {claudeMenuLabel(task)}
            </button>
          )}
          <Link href={`/tasks/${task.ref}`} className="h-12 rounded-2xl border border-border flex items-center justify-center gap-2 text-[15px] font-medium text-foreground active:bg-muted">
            <ExternalLink className="w-4 h-4" /> Open task
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// `cols` lays short, fixed option sets out as a grid so every option is visible; long sets scroll sideways.
function Group({ label, cols, children }: { label: string; cols?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</div>
      <div className={cn(cols ? `grid ${cols} gap-2 px-4 [&>button]:w-full [&>button]:px-2` : 'flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden')}>{children}</div>
    </div>
  );
}

function Opt({ on, tone, onClick, children }: { on?: boolean; tone?: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 h-11 px-4 rounded-full border text-sm font-medium whitespace-nowrap transition-colors active:scale-95',
        on ? (tone ?? 'bg-foreground text-background border-foreground') : 'border-border text-foreground bg-background',
      )}
    >
      {children}
    </button>
  );
}
