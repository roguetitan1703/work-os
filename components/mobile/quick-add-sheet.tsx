'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowUp, X } from 'lucide-react';
import { createTaskAction } from '@/app/actions';
import { parseQuickAdd } from '@/lib/quick-parse';
import { addDays, resolveDate, weekday } from '@/lib/dates';
import { fmtDue } from '@/lib/format';
import type { Priority } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from '../app-context';

const PRIORITIES: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const PRIO_TONE: Record<Priority, string> = {
  P1: 'bg-red-500 text-white border-red-500',
  P2: 'bg-orange-500 text-white border-orange-500',
  P3: 'bg-yellow-500 text-white border-yellow-500',
  P4: 'bg-foreground text-background border-foreground',
};

/**
 * Phone capture: a bottom sheet with one big field and one-tap chips for due date,
 * priority and project. The quick syntax (@project !1 due:fri) still works when typed.
 */
export function QuickAddSheet({ open, onClose, defaultProject }: { open: boolean; onClose: () => void; defaultProject?: string }) {
  const { projects, today } = useApp();
  const router = useRouter();
  const [text, setText] = useState('');
  const [prio, setPrio] = useState<Priority | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(defaultProject ?? null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  const active = useMemo(() => projects.filter(p => p.status === 'active' || p.status === 'paused'), [projects]);
  const parsed = useMemo(() => parseQuickAdd(text, projects), [text, projects]);
  const typedDue = parsed.due ? resolveDate(parsed.due, today) : null;
  const finalDue = due ?? typedDue ?? null;
  const finalPrio = prio ?? parsed.priority ?? null;
  const finalProject = project ?? parsed.project ?? null;

  const friday = (() => {
    let d = today;
    while (weekday(d) !== 5) d = addDays(d, 1);
    return d;
  })();
  const DUE_CHIPS = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: weekday(today) === 5 ? 'Next Fri' : 'Friday', value: weekday(today) === 5 ? addDays(friday, 7) : friday },
    { label: 'Next week', value: addDays(today, 7) },
  ];

  function reset() {
    setText('');
    setPrio(null);
    setDue(null);
    setProject(defaultProject ?? null);
  }

  function create(openAfter = false) {
    if (!parsed.title.trim()) return;
    start(async () => {
      const res = await createTaskAction({ ...parsed, due: finalDue, priority: finalPrio ?? undefined, project: finalProject });
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Added #${res.data.ref}`, { action: { label: 'Open', onClick: () => router.push(`/tasks/${res.data.ref}`) } });
      reset();
      if (openAfter) {
        onClose();
        router.push(`/tasks/${res.data.ref}`);
      } else {
        router.refresh();
        input.current?.focus();
      }
    });
  }

  if (!open) return null;
  return (
    <div className="md:hidden fixed inset-0 z-50">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />
      <div
        data-quick-add
        className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-background shadow-2xl animate-in slide-in-from-bottom duration-200"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <div className="mx-auto mt-2.5 mb-1 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        <div className="flex items-center justify-between px-4 pt-1">
          <span className="text-sm font-semibold text-muted-foreground">New task</span>
          <button onClick={onClose} className="w-9 h-9 -mr-2 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4">
          <textarea
            ref={input}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                create();
              }
            }}
            rows={2}
            enterKeyHint="done"
            placeholder="What needs doing?"
            className="w-full resize-none bg-transparent text-xl leading-snug text-foreground outline-none placeholder:text-muted-foreground/50 py-2"
          />
        </div>

        <Chips label="Due">
          {DUE_CHIPS.map(c => (
            <Chip key={c.label} on={finalDue === c.value} onClick={() => setDue(due === c.value ? null : c.value)}>
              {c.label}
            </Chip>
          ))}
          {finalDue && !DUE_CHIPS.some(c => c.value === finalDue) && <Chip on>{fmtDue(finalDue, today)}</Chip>}
        </Chips>
        <Chips label="Priority">
          {PRIORITIES.map(p => (
            <Chip key={p} on={finalPrio === p} tone={PRIO_TONE[p]} onClick={() => setPrio(prio === p ? null : p)}>
              {p}
            </Chip>
          ))}
        </Chips>
        <Chips label="Project">
          {active.map(p => (
            <Chip key={p.id} on={finalProject?.toLowerCase() === p.name.toLowerCase() || finalProject === p.id} onClick={() => setProject(project === p.name ? null : p.name)}>
              {p.name}
            </Chip>
          ))}
        </Chips>

        <div className="flex items-center gap-2 px-4 pt-3">
          <button
            onClick={() => create(true)}
            disabled={!parsed.title.trim() || pending}
            className="h-12 px-4 rounded-2xl border border-border text-sm font-medium text-foreground disabled:opacity-40 active:bg-muted"
          >
            Add &amp; open
          </button>
          <button
            onClick={() => create()}
            disabled={!parsed.title.trim() || pending}
            className="flex-1 h-12 rounded-2xl bg-foreground text-background text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            <ArrowUp className="w-5 h-5" /> Add task
          </button>
        </div>
      </div>
    </div>
  );
}

function Chips({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>
    </div>
  );
}

function Chip({ on, tone, onClick, children }: { on?: boolean; tone?: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 h-9 px-3.5 rounded-full border text-sm font-medium whitespace-nowrap transition-colors active:scale-95',
        on ? (tone ?? 'bg-foreground text-background border-foreground') : 'border-border text-foreground bg-background',
      )}
    >
      {children}
    </button>
  );
}
