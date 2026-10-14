'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { bulkCreateTasksAction } from '@/app/actions';
import { parseMarkdownTable, type ParsedTaskInput } from '@/lib/parse-markdown-table';
import { MODE_NAMES } from '@/lib/modes';
import { STATUSES, type Mode, type Priority, type Status } from '@/lib/types';
import { cn } from '@/lib/utils';
import { BottomSheet } from './sheet';

type Tab = 'markdown' | 'json';
const PRIOS = ['P1', 'P2', 'P3', 'P4'];

function parseJSON(raw: string): { tasks: ParsedTaskInput[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
  } catch {
    return { tasks: [], errors: ['Invalid JSON. Make sure it is a valid JSON array.'] };
  }
  if (!Array.isArray(parsed)) return { tasks: [], errors: ['Expected a JSON array [ ... ].'] };
  const errors: string[] = [];
  const tasks: ParsedTaskInput[] = [];
  parsed.forEach((r, i) => {
    const row = r as Record<string, unknown>;
    const title = row.title ?? row.task;
    if (typeof title !== 'string' || !title.trim()) return void errors.push(`Row ${i + 1}: missing "title"`);
    if (row.mode && !MODE_NAMES.includes(row.mode as string)) return void errors.push(`Row ${i + 1}: invalid mode "${row.mode}"`);
    const prio = typeof row.priority === 'string' && PRIOS.includes(row.priority.toUpperCase()) ? row.priority.toUpperCase() : 'P2';
    const status = typeof row.status === 'string' ? (STATUSES.find(s => s.toLowerCase() === (row.status as string).toLowerCase()) ?? 'Not Started') : 'Not Started';
    const project = row.project ?? row.projectClient;
    const desc = row.description ?? row.notes;
    tasks.push({
      title: title.trim(),
      mode: (row.mode as Mode) ?? null,
      project: typeof project === 'string' ? project || null : null,
      priority: prio as Priority,
      estimateMins: typeof row.estimateMins === 'number' && row.estimateMins >= 0 ? Math.round(row.estimateMins) : null,
      due: typeof row.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.due) ? row.due : undefined,
      status: status as Status,
      description: typeof desc === 'string' ? desc : '',
    });
  });
  return { tasks, errors };
}

/** Phone Import: paste a markdown table or JSON array from Claude, review as a checklist, insert. */
export function MobileImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('markdown');
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<{ task: ParsedTaskInput; checked: boolean }[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  function reset() {
    setRaw('');
    setPreview(null);
    setErrors([]);
  }
  function close() {
    reset();
    onClose();
  }
  function review() {
    const res = tab === 'markdown' ? parseMarkdownTable(raw) : parseJSON(raw);
    setErrors(res.errors);
    if (res.tasks.length) setPreview(res.tasks.map(t => ({ task: t, checked: true })));
  }
  async function insert() {
    const selected = (preview ?? []).filter(r => r.checked).map(r => r.task);
    if (!selected.length) return;
    setBusy(true);
    try {
      const res = await bulkCreateTasksAction(selected);
      if (!res.ok) throw new Error(res.error);
      toast.success(`Inserted ${selected.length} task${selected.length !== 1 ? 's' : ''}.`);
      close();
      router.refresh();
    } catch {
      toast.error('Failed to insert tasks. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const count = preview?.filter(r => r.checked).length ?? 0;

  return (
    <BottomSheet title="Import tasks" onClose={close}>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/70 p-1">
        {(['markdown', 'json'] as const).map(t => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              reset();
            }}
            className={cn('h-11 rounded-lg text-sm font-medium', tab === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
          >
            {t === 'markdown' ? 'Markdown table' : 'JSON array'}
          </button>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="mt-3 rounded-xl bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400 space-y-1">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      {!preview ? (
        <>
          <p className="mt-3 text-[13px] text-muted-foreground">
            {tab === 'markdown' ? 'Ask Claude for: | Task | Mode | Project | Priority | Estimate | Due | Status | Notes |' : 'Ask Claude for a JSON array with title, mode, project, priority, estimateMins, due, status, description.'}
          </p>
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            placeholder={tab === 'markdown' ? 'Paste your markdown table here…' : 'Paste JSON array here…'}
            className="mt-2 w-full min-h-48 rounded-xl border border-input bg-transparent p-3 font-mono text-[16px] outline-none"
          />
          <div className="mt-3 flex gap-2">
            <button onClick={close} className="h-12 px-5 rounded-2xl border border-border text-sm font-medium active:bg-muted">
              Cancel
            </button>
            <button onClick={review} disabled={!raw.trim()} className="flex-1 h-12 rounded-2xl bg-foreground text-background text-base font-semibold disabled:opacity-40">
              Preview
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
            {preview.map((r, i) => (
              <button
                key={i}
                onClick={() => setPreview(p => p && p.map((x, j) => (j === i ? { ...x, checked: !x.checked } : x)))}
                className={cn('w-full min-h-14 flex items-center gap-3 px-3 py-2 text-left', !r.checked && 'opacity-40')}
              >
                <span className={cn('w-5 h-5 shrink-0 rounded border-2 flex items-center justify-center text-[11px] text-background', r.checked ? 'bg-foreground border-foreground' : 'border-muted-foreground/50')}>
                  {r.checked ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-snug">{r.task.title}</span>
                  <span className="block text-[12px] text-muted-foreground truncate">
                    {[r.task.priority, r.task.mode, r.task.project, r.task.estimateMins ? `${r.task.estimateMins}m` : null, r.task.due, r.task.status !== 'Not Started' ? r.task.status : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setPreview(null)} className="h-12 px-5 rounded-2xl border border-border text-sm font-medium active:bg-muted">
              Back
            </button>
            <button onClick={insert} disabled={!count || busy} className="flex-1 h-12 rounded-2xl bg-foreground text-background text-base font-semibold disabled:opacity-40">
              {busy ? 'Inserting…' : `Insert ${count} task${count !== 1 ? 's' : ''}`}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  );
}
