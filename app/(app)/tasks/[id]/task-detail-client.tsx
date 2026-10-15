'use client';

import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Archive, ArchiveRestore, CheckCircle2, ExternalLink, Plus, Trash2, TrendingUp, X } from 'lucide-react';
import {
  addCommentAction,
  checklistAction,
  completeTaskAction,
  setArchivedAction,
  updateTaskAction,
  type Result,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { PrioritySelect, StatusSelect } from '@/components/inline-selects';
import { ProgressDialog } from '@/components/progress-dialog';
import { DeleteTaskButton } from '@/components/trash-controls';
import { useApp } from '@/components/app-context';
import { MODES } from '@/lib/modes';
import { fmtAgo, fmtDue } from '@/lib/format';
import type { Mode, Recurrence, Task, TaskPatch } from '@/lib/types';
import { cn } from '@/lib/utils';

const field =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring dark:bg-input/30';

type Props = { task: Task; projectName: string | null; dependencies: Task[]; dependents: Task[] };

export function TaskDetailClient({ task, projectName, dependencies, dependents }: Props) {
  const { projects, today } = useApp();
  const [pending, start] = useTransition();
  const [progressOpen, setProgressOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [comment, setComment] = useState('');
  const [newItem, setNewItem] = useState('');
  const [newLink, setNewLink] = useState('');
  const [newDep, setNewDep] = useState('');
  const [tagText, setTagText] = useState(task.tags.join(', '));
  const [blockedReason, setBlockedReason] = useState(task.blockedReason);
  const closed = task.status === 'Done' || task.status === 'Dropped';
  const overdue = !!task.due && task.due < today && !closed;

  function exec<T>(fn: () => Promise<Result<T>>, msg?: string, after?: () => void) {
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      if (msg) toast.success(msg);
      after?.();
    });
  }
  const patch = (p: TaskPatch, msg = 'Saved') => exec(() => updateTaskAction(task.id, p), msg);

  return (
    <div className={cn('space-y-5', pending && 'opacity-80')}>
      <BackLink href="/tasks" className="hidden md:inline-flex items-center gap-1 -mb-2 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-3 h-3" /> Tasks
      </BackLink>
      {/* Title row */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">#{task.ref}</span>
          {projectName && (
            <Link href={`/projects/${task.projectId}`} className="hover:text-foreground">
              {projectName}
            </Link>
          )}
          <span suppressHydrationWarning>· created {fmtAgo(task.createdAt)} by {task.createdBy === 'claude' ? 'Claude' : task.createdBy === 'claude-code' ? 'Claude Code' : task.createdBy === 'me' ? 'you' : 'system'}</span>
          {task.archived && <span className="px-1.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">archived</span>}
        </div>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && patch({ title: title.trim() }, 'Title saved')}
          className={cn('w-full bg-transparent text-2xl font-bold outline-none', closed && 'line-through text-muted-foreground')}
        />
      </div>

      {/* Primary controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusSelect value={task.status} disabled={pending} className="h-8 border-border px-2" onChange={s => patch({ status: s }, `Status → ${s}`)} />
        <PrioritySelect value={task.priority} disabled={pending} className="h-8 border-border px-2" onChange={p => patch({ priority: p }, `Priority → ${p}`)} />
        <button onClick={() => setProgressOpen(true)} className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-border hover:bg-muted text-sm" disabled={closed}>
          <span className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
          </span>
          <span className="font-mono text-xs">{task.progress}%</span>
          <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        {!closed && (
          <Button size="sm" className="gap-1.5 h-8" onClick={() => exec(() => completeTaskAction(task.id), 'Completed')}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Complete
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 h-8 ml-auto text-muted-foreground"
          onClick={() => exec(() => setArchivedAction(task.id, !task.archived), task.archived ? 'Restored' : 'Archived')}
        >
          {task.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
          {task.archived ? 'Restore' : 'Archive'}
        </Button>
        <DeleteTaskButton taskRef={task.ref} title={task.title} />
      </div>

      {task.status === 'Blocked' && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 space-y-1">
          <label className="text-xs font-medium text-red-600 dark:text-red-400">Blocked because…</label>
          <input
            value={blockedReason}
            onChange={e => setBlockedReason(e.target.value)}
            onBlur={() => blockedReason !== task.blockedReason && patch({ blockedReason }, 'Reason saved')}
            placeholder="Waiting on client feedback, missing access…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
      )}

      {/* Fields grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <Field label="Project">
          <input
            list="project-options-detail"
            defaultValue={projectName ?? ''}
            className={field}
            onBlur={e => {
              const v = e.target.value.trim();
              if (v !== (projectName ?? '')) patch({ project: v || null }, 'Project saved');
            }}
          />
          <datalist id="project-options-detail">
            {projects.map(p => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Mode">
          <select className={field} value={task.mode ?? ''} onChange={e => patch({ mode: (e.target.value || null) as Mode | null })}>
            <option value="">—</option>
            {MODES.map(m => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Estimate (min)">
          <input
            type="number"
            min={0}
            defaultValue={task.estimateMins ?? ''}
            className={field}
            onBlur={e => {
              const v = e.target.value ? parseInt(e.target.value, 10) : null;
              if (v !== task.estimateMins) patch({ estimateMins: v });
            }}
          />
        </Field>
        <Field label="Start">
          <input type="date" value={task.start ?? ''} className={field} onChange={e => patch({ start: e.target.value || null })} />
        </Field>
        <Field label={overdue ? `Due · ${fmtDue(task.due, today)} (overdue)` : `Due${task.due ? ' · ' + fmtDue(task.due, today) : ''}`} warn={overdue}>
          <input type="date" value={task.due ?? ''} className={field} onChange={e => patch({ due: e.target.value || null })} />
        </Field>
        <Field label="Repeats">
          <RecurrenceSelect value={task.recurrence} onChange={r => patch({ recurrence: r })} />
        </Field>
        <Field label="Tags" className="col-span-2 md:col-span-3">
          <input
            value={tagText}
            onChange={e => setTagText(e.target.value)}
            onBlur={() => {
              const tags = tagText.split(',').map(t => t.trim()).filter(Boolean);
              if (tags.join(',') !== task.tags.join(',')) patch({ tags });
            }}
            placeholder="comma, separated"
            className={field}
          />
        </Field>
      </div>

      {/* Description */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Description</h3>
        <Textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          onBlur={() => description !== task.description && patch({ description }, 'Description saved')}
          rows={Math.min(16, Math.max(4, description.split('\n').length + 1))}
          placeholder="Context, acceptance criteria, notes…"
        />
      </section>

      {/* Checklist */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Checklist {task.checklist.length > 0 && `· ${task.checklist.filter(i => i.done).length}/${task.checklist.length}`}
        </h3>
        <div className="space-y-0.5">
          {task.checklist.map(item => (
            <div key={item.id} className="group flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/50">
              <input
                type="checkbox"
                checked={item.done}
                onChange={e => exec(() => checklistAction(task.id, e.target.checked ? { check: [item.id] } : { uncheck: [item.id] }))}
              />
              <span className={cn('text-sm flex-1', item.done && 'line-through text-muted-foreground')}>{item.text}</span>
              <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500" onClick={() => exec(() => checklistAction(task.id, { remove: [item.id] }))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <AddInline
          value={newItem}
          onChange={setNewItem}
          placeholder="Add item…"
          onSubmit={() => exec(() => checklistAction(task.id, { add: [newItem] }), undefined, () => setNewItem(''))}
        />
      </section>

      {/* Links */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Links</h3>
        {task.links.map((l, i) => (
          <div key={i} className="group flex items-center gap-2 text-sm">
            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <a href={l.url} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline truncate">
              {l.label || l.url}
            </a>
            <button
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500"
              onClick={() => patch({ links: task.links.filter((_, j) => j !== i) }, 'Link removed')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <AddInline
          value={newLink}
          onChange={setNewLink}
          placeholder="Paste a URL…"
          onSubmit={() => exec(() => updateTaskAction(task.id, { links: [...task.links, newLink] }), 'Link added', () => setNewLink(''))}
        />
      </section>

      {/* Dependencies */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Waits on</h3>
        {dependencies.map(d => (
          <div key={d.id} className="group flex items-center gap-2 text-sm">
            <Link href={`/tasks/${d.ref}`} className={cn('hover:underline', (d.status === 'Done' || d.status === 'Dropped') && 'line-through text-muted-foreground')}>
              #{d.ref} {d.title}
            </Link>
            <span className="text-xs text-muted-foreground">{d.status}</span>
            <button
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500"
              onClick={() => patch({ dependsOn: task.dependsOn.filter(x => x !== d.id) }, 'Dependency removed')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <AddInline
          value={newDep}
          onChange={setNewDep}
          placeholder="Task number, e.g. 42"
          onSubmit={() => exec(() => updateTaskAction(task.id, { dependsOn: [...task.dependsOn, newDep] }), 'Dependency added', () => setNewDep(''))}
        />
        {dependents.length > 0 && (
          <p className="text-xs text-muted-foreground pt-1">
            Blocks:{' '}
            {dependents.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <Link href={`/tasks/${d.ref}`} className="hover:underline">
                  #{d.ref} {d.title}
                </Link>
              </span>
            ))}
          </p>
        )}
      </section>

      {/* Comment */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add a note</h3>
        <Textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          rows={2}
          placeholder="Decision, call notes, what happened… (Ctrl+Enter)"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment.trim()) exec(() => addCommentAction(task.id, comment), 'Note added', () => setComment(''));
          }}
        />
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={!comment.trim() || pending} onClick={() => exec(() => addCommentAction(task.id, comment), 'Note added', () => setComment(''))}>
            Add note
          </Button>
        </div>
      </section>

      {progressOpen && <ProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </div>
  );
}

function Field({ label, children, className, warn }: { label: string; children: React.ReactNode; className?: string; warn?: boolean }) {
  return (
    <label className={cn('space-y-1 block', className)}>
      <span className={cn('text-[11px]', warn ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground')}>{label}</span>
      {children}
    </label>
  );
}

function AddInline({ value, onChange, placeholder, onSubmit }: { value: string; onChange: (v: string) => void; placeholder: string; onSubmit: () => void }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Plus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        className="flex-1 h-7 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

const RECURRENCE_OPTIONS: { label: string; value: Recurrence | null }[] = [
  { label: 'Never', value: null },
  { label: 'Daily', value: { freq: 'daily', interval: 1 } },
  { label: 'Weekdays', value: { freq: 'weekdays', interval: 1 } },
  { label: 'Weekly', value: { freq: 'weekly', interval: 1 } },
  { label: 'Every 2 weeks', value: { freq: 'weekly', interval: 2 } },
  { label: 'Monthly', value: { freq: 'monthly', interval: 1 } },
];

function RecurrenceSelect({ value, onChange }: { value: Recurrence | null; onChange: (r: Recurrence | null) => void }) {
  const idx = RECURRENCE_OPTIONS.findIndex(o => JSON.stringify(o.value) === JSON.stringify(value));
  return (
    <select className={field} value={idx === -1 ? 'custom' : String(idx)} onChange={e => onChange(RECURRENCE_OPTIONS[Number(e.target.value)].value)}>
      {RECURRENCE_OPTIONS.map((o, i) => (
        <option key={i} value={i}>
          {o.label}
        </option>
      ))}
      {idx === -1 && value && <option value="custom">{`Every ${value.interval} ${value.freq}`}</option>}
    </select>
  );
}
