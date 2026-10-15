'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowUp, Plus } from 'lucide-react';
import { createTaskAction } from '@/app/actions';
import { parseQuickAdd } from '@/lib/quick-parse';
import { resolveDate } from '@/lib/dates';
import { fmtDue, fmtMins } from '@/lib/format';
import type { Mode, TaskInput } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useApp } from './app-context';
import { TaskForm } from './task-form';
import { usePhone } from './mobile/use-phone';

export const HELP = '@project  !1–!4  #tag  due:fri  start:mon  ~45m  mode:code';

/** Single-line capture. Enter creates; Shift+Enter opens the full form prefilled. */
export function QuickAddBar({
  defaults,
  autoFocus,
  onCreated,
  className,
}: {
  defaults?: { project?: string; mode?: Mode };
  autoFocus?: boolean;
  onCreated?: () => void;
  className?: string;
}) {
  const { projects, today } = useApp();
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const [formOpen, setFormOpen] = useState(false);
  const phone = usePhone();
  const parsed = useMemo(() => parseQuickAdd(text, projects), [text, projects]);
  const due = parsed.due ? resolveDate(parsed.due, today) : null;

  const input: TaskInput = {
    ...parsed,
    project: parsed.project ?? defaults?.project ?? null,
    mode: parsed.mode ?? defaults?.mode ?? null,
  };

  function create() {
    if (!parsed.title) return;
    start(async () => {
      const res = await createTaskAction(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Created #${res.data.ref} ${res.data.title}`);
      setText('');
      onCreated?.();
    });
  }

  const chips: string[] = [];
  if (input.project) chips.push(`@${input.project}`);
  if (parsed.priority) chips.push(parsed.priority);
  if (parsed.due) chips.push(due ? `due ${fmtDue(due, today)}` : `due ? "${parsed.due}"`);
  if (parsed.start) chips.push(`start ${parsed.start}`);
  if (parsed.estimateMins) chips.push(fmtMins(parsed.estimateMins));
  if (input.mode) chips.push(input.mode);
  parsed.tags?.forEach(t => chips.push(`#${t}`));

  return (
    <div className={cn('rounded-lg border border-border bg-card', className)}>
      <div className="flex items-center gap-2 px-3">
        <Plus className="w-4 h-4 text-muted-foreground shrink-0" />
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              setFormOpen(true);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              create();
            }
          }}
          disabled={pending}
          autoFocus={autoFocus}
          placeholder={phone ? "Add a task…" : "Add a task…  (Enter to save, Shift+Enter for details)"}
          enterKeyHint="done"
          className="flex-1 min-w-0 h-12 md:h-10 bg-transparent text-[16px] md:text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={create}
          disabled={pending || !parsed.title}
          aria-label="Add task"
          className="md:hidden -mr-2 w-11 h-11 shrink-0 rounded-full flex items-center justify-center bg-foreground text-background disabled:opacity-30 active:scale-95 transition-transform"
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      </div>
      {text && (
        <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap text-[11px]">
          {chips.length ? (
            chips.map(c => (
              <span key={c} className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {c}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground/70">{HELP}</span>
          )}
        </div>
      )}
      {formOpen && (
        <TaskForm
          open={formOpen}
          onClose={() => {
            setFormOpen(false);
            setText('');
            onCreated?.();
          }}
          initial={{ ...input, due: due ?? undefined, start: parsed.start ? (resolveDate(parsed.start, today) ?? undefined) : undefined }}
        />
      )}
    </div>
  );
}

/** Global "N" shortcut → quick add dialog. */
export function QuickAddLauncher() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (!typing && !document.querySelector('[role="dialog"]') && (e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        New task
        <kbd className="ml-auto text-[10px] font-mono border border-border rounded px-1">N</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl top-[20%] translate-y-0">
          <DialogHeader>
            <DialogTitle className="text-sm">Quick add</DialogTitle>
          </DialogHeader>
          {open && <QuickAddBar autoFocus onCreated={() => setOpen(false)} />}
          <p className="text-[11px] text-muted-foreground">{HELP}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
