'use client';

import { BackLink } from '@/components/back-link';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Bot, Check, ChevronRight, ExternalLink, FileText, MoreHorizontal, Plus, Send, Trash2, TrendingUp, X } from 'lucide-react';
import { addCommentAction, checklistAction, completeTaskAction, deleteTaskAction, restoreTaskAction, setArchivedAction, updateTaskAction } from '@/app/actions';
import { createNoteAction } from '@/app/(app)/notes/actions';
import { addDays } from '@/lib/dates';
import { fmtDue } from '@/lib/format';
import { MODES } from '@/lib/modes';
import type { Activity, Priority, Recurrence, Status, Task, TaskPatch } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ActivityTimeline } from '../activity-timeline';
import { ProgressDialog } from '../progress-dialog';
import { useApp } from '../app-context';
import { BottomSheet } from './sheet';
import { ClaudeBadge, ClaudeMarkSheet, ClaudeOutcome, claudeMenuLabel } from '../give-to-claude';

const STATUSES: { s: Status; tone: string }[] = [
  { s: 'Not Started', tone: 'bg-foreground text-background' },
  { s: 'In Progress', tone: 'bg-blue-600 text-white' },
  { s: 'Blocked', tone: 'bg-red-600 text-white' },
];
const PRIOS: { p: Priority; tone: string }[] = [
  { p: 'P1', tone: 'bg-red-500 text-white' },
  { p: 'P2', tone: 'bg-orange-500 text-white' },
  { p: 'P3', tone: 'bg-yellow-500 text-white' },
  { p: 'P4', tone: 'bg-foreground text-background' },
];

type NoteRef = { id: string; title: string; firstLine: string } | null;
type Dep = { id: string; ref: number; title: string; status: Status };

/** Full-screen task view for phones: one-tap status/priority, native pickers, sticky Done. */
export function MobileTaskDetail({
  task,
  activity,
  note,
  dependencies,
  dependents,
}: {
  task: Task;
  activity: Activity[];
  note: NoteRef;
  dependencies: Dep[];
  dependents: Dep[];
}) {
  const { today, projects, projectName } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [comment, setComment] = useState('');
  const [newItem, setNewItem] = useState('');
  const [menu, setMenu] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [sheet, setSheet] = useState<null | 'estimate' | 'tags' | 'blocked' | 'link' | 'dep' | 'delete'>(null);
  const [delReason, setDelReason] = useState('');
  const dateRef = useRef<HTMLInputElement>(null);
  const closed = task.status === 'Done' || task.status === 'Dropped';
  const overdue = !!task.due && task.due < today && !closed;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      if (ok) toast.success(ok);
      router.refresh();
    });
  const patch = (p: TaskPatch, ok?: string) => run(() => updateTaskAction(task.id, p), ok);

  function complete() {
    navigator.vibrate?.(15);
    const prev = task.status;
    start(async () => {
      const r = await completeTaskAction(task.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Done: ${task.title}`, {
        action: { label: 'Undo', onClick: () => patch({ status: prev }) },
      });
      router.refresh();
    });
  }

  async function addNote() {
    const r = await createNoteAction({ task: task.ref });
    if ('error' in r) toast.error(r.error);
    else router.push(`/notes/${r.id}`);
  }

  return (
    <div className="pb-28">
      {/* Top bar */}
      <div className="sticky -top-3 z-30 -mx-4 -mt-3 px-2 bg-background/85 backdrop-blur-xl" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="h-14 flex items-center justify-between">
          <BackLink href="/tasks" aria-label="Back" className="h-11 px-2 flex items-center gap-1 text-[16px] text-foreground active:opacity-60">
            <ArrowLeft className="w-5 h-5" /> Back
          </BackLink>
          <span className="font-mono text-sm text-muted-foreground">#{task.ref}</span>
          <button onClick={() => setMenu(m => !m)} className="w-11 h-11 flex items-center justify-center rounded-full active:bg-muted" aria-label="More actions">
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>
        {menu && (
          <div className="absolute right-3 top-14 w-56 rounded-2xl border border-border bg-popover shadow-xl overflow-hidden z-40">
            {!closed && (
              <MenuItem onClick={() => (setMenu(false), patch({ status: 'Dropped' }, 'Dropped'))}>Drop task</MenuItem>
            )}
            {closed && <MenuItem onClick={() => (setMenu(false), patch({ status: 'Not Started' }, 'Reopened'))}>Reopen</MenuItem>}
            {!closed && !task.archived && (
              <MenuItem onClick={() => (setMenu(false), setClaudeOpen(true))}>
                <Bot className="w-4 h-4" /> {claudeMenuLabel(task)}
              </MenuItem>
            )}
            <MenuItem onClick={() => (setMenu(false), run(() => setArchivedAction(task.id, !task.archived), task.archived ? 'Unarchived' : 'Archived'))}>
              <Archive className="w-4 h-4" /> {task.archived ? 'Unarchive' : 'Archive'}
            </MenuItem>
            <MenuItem danger onClick={() => (setMenu(false), setDelReason(''), setSheet('delete'))}>
              <Trash2 className="w-4 h-4" /> Delete
            </MenuItem>
          </div>
        )}
      </div>

      {/* Title */}
      <textarea
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== task.title && patch({ title: title.trim() })}
        rows={Math.min(4, Math.max(1, Math.ceil(title.length / 26)))}
        className={cn('mt-1 w-full resize-none bg-transparent text-[24px] leading-tight font-bold tracking-tight outline-none', closed && 'line-through text-muted-foreground')}
      />
      <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        {task.projectId && (
          <Link href={`/projects/${task.projectId}`} className="text-blue-600 dark:text-blue-400">
            {projectName(task.projectId)}
          </Link>
        )}
        {closed && <span>{task.status}</span>}
        {task.archived && <span className="text-amber-600">Archived</span>}
        <ClaudeBadge task={task} />
      </div>
      <ClaudeOutcome task={task} className="mt-1" />
      {claudeOpen && <ClaudeMarkSheet task={task} onClose={() => setClaudeOpen(false)} />}

      {/* Status */}
      {!closed && (
        <Field label="Status">
          <div className="grid grid-cols-3 gap-2">
            {STATUSES.map(({ s, tone }) => (
              <button
                key={s}
                disabled={pending}
                onClick={() => s !== task.status && patch({ status: s }, `→ ${s}`)}
                className={cn('h-11 rounded-xl text-[14px] font-semibold border transition-colors active:scale-[0.97]', task.status === s ? cn(tone, 'border-transparent') : 'border-border text-foreground')}
              >
                {s}
              </button>
            ))}
          </div>
          {task.status === 'Blocked' && (
            <button onClick={() => setSheet('blocked')} className="mt-2 w-full min-h-11 px-4 py-2 rounded-xl border border-red-500/30 bg-red-500/5 text-left text-sm text-red-600 dark:text-red-400 active:bg-red-500/10">
              {task.blockedReason ? `Blocked: ${task.blockedReason}` : 'Add the reason it is blocked'}
            </button>
          )}
        </Field>
      )}

      {/* Priority */}
      <Field label="Priority">
        <div className="grid grid-cols-4 gap-2">
          {PRIOS.map(({ p, tone }) => (
            <button
              key={p}
              disabled={pending}
              onClick={() => p !== task.priority && patch({ priority: p })}
              className={cn('h-11 rounded-xl text-[15px] font-semibold border active:scale-[0.97]', task.priority === p ? cn(tone, 'border-transparent') : 'border-border text-foreground')}
            >
              {p}
            </button>
          ))}
        </div>
      </Field>

      {/* Due + progress */}
      <Field label="Due">
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.click()}
            className={cn('relative shrink-0 h-10 px-4 rounded-full border text-[15px] font-medium', task.due ? (overdue ? 'border-red-500 text-red-600 dark:text-red-400' : 'border-foreground text-foreground') : 'border-dashed border-border text-muted-foreground')}
          >
            {task.due ? fmtDue(task.due, today) : 'Pick date'}
            <input
              ref={dateRef}
              type="date"
              value={task.due ?? ''}
              onChange={e => patch({ due: e.target.value || null })}
              className="absolute inset-0 opacity-0 pointer-events-none"
              tabIndex={-1}
            />
          </button>
          {[
            { l: 'Today', v: today },
            { l: 'Tomorrow', v: addDays(today, 1) },
            { l: '+1 week', v: addDays(task.due && task.due > today ? task.due : today, 7) },
          ]
            .filter(c => c.v !== task.due)
            .map(c => (
            <button key={c.l} onClick={() => patch({ due: c.v })} className="shrink-0 h-10 px-4 rounded-full border border-border text-[15px] active:bg-muted">
              {c.l}
            </button>
          ))}
          {task.due && (
            <button onClick={() => patch({ due: null })} className="shrink-0 h-10 px-4 rounded-full text-[15px] text-muted-foreground">
              Clear
            </button>
          )}
        </div>
      </Field>

      {!closed && (
        <Field label="Progress">
          <button onClick={() => setProgressOpen(true)} className="w-full flex items-center gap-3 h-12 px-4 rounded-xl border border-border active:bg-muted">
            <span className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <span className="block h-full bg-blue-500" style={{ width: `${task.progress}%` }} />
            </span>
            <span className="font-mono text-sm w-10 text-right">{task.progress}%</span>
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
          </button>
        </Field>
      )}

      {/* Project + mode: native pickers */}
      <div className="mt-5 rounded-2xl border border-border/70 bg-card divide-y divide-border/60">
        <SelectRow label="Project" value={task.projectId ?? ''} onChange={v => patch({ project: v || null })}>
          <option value="">None</option>
          {projects
            .filter(p => p.status === 'active' || p.status === 'paused' || p.id === task.projectId)
            .map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </SelectRow>
        <SelectRow label="Mode" value={task.mode ?? ''} onChange={v => patch({ mode: (v || null) as Task['mode'] })}>
          <option value="">None</option>
          {MODES.map(m => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </SelectRow>
        <label className="relative flex items-center gap-3 px-4 h-12 active:bg-muted/60">
          <span className="text-[16px] text-foreground w-20">Start</span>
          <span className={cn('flex-1 text-right text-[16px]', task.start ? 'text-foreground' : 'text-muted-foreground')}>{task.start ? fmtDue(task.start, today) : 'None'}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
          <input type="date" value={task.start ?? ''} onChange={e => patch({ start: e.target.value || null })} aria-label="Start date" className="absolute inset-0 w-full h-full opacity-0" />
        </label>
        <button onClick={() => setSheet('estimate')} className="w-full flex items-center gap-3 px-4 h-12 text-left active:bg-muted/60">
          <span className="text-[16px] text-foreground w-20">Estimate</span>
          <span className={cn('flex-1 text-right text-[16px]', task.estimateMins != null ? 'text-foreground' : 'text-muted-foreground')}>{task.estimateMins != null ? fmtMins(task.estimateMins) : 'None'}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
        </button>
        <SelectRow label="Repeats" value={recIdx(task.recurrence)} onChange={v => patch({ recurrence: RECURRENCE_OPTIONS[Number(v)]?.value ?? task.recurrence })}>
          {RECURRENCE_OPTIONS.map((o, i) => (
            <option key={i} value={String(i)}>
              {o.label}
            </option>
          ))}
          {recIdx(task.recurrence) === 'custom' && task.recurrence && <option value="custom">{`Every ${task.recurrence.interval} ${task.recurrence.freq}`}</option>}
        </SelectRow>
        <button onClick={() => setSheet('tags')} className="w-full flex items-center gap-3 px-4 min-h-12 py-2 text-left active:bg-muted/60">
          <span className="text-[16px] text-foreground w-20 shrink-0">Tags</span>
          <span className="flex-1 flex flex-wrap justify-end gap-1.5">
            {task.tags.length ? task.tags.map(t => (
              <span key={t} className="px-2 py-0.5 rounded-full bg-muted text-[13px] text-foreground">{t}</span>
            )) : <span className="text-[16px] text-muted-foreground">None</span>}
          </span>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
        </button>
      </div>

      {/* Note */}
      <Field label="Note">
        {note ? (
          <Link href={`/notes/${note.id}`} className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border/70 bg-card active:bg-muted/60">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{note.title}</div>
              <div className="text-sm text-muted-foreground truncate">{note.firstLine || 'Empty page'}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
          </Link>
        ) : (
          <button onClick={addNote} className="w-full h-12 rounded-2xl border border-dashed border-border text-muted-foreground flex items-center justify-center gap-2 active:bg-muted">
            <Plus className="w-4 h-4" /> Add a note
          </button>
        )}
      </Field>

      {/* Checklist */}
      <Field label={`Checklist${task.checklist.length ? ` · ${task.checklist.filter(i => i.done).length}/${task.checklist.length}` : ''}`}>
        <div className="rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
          {task.checklist.map((it, i) => (
            <div key={it.id} className="flex items-center active:bg-muted/60">
              <button
                onClick={() => run(() => checklistAction(task.id, it.done ? { uncheck: [i + 1] } : { check: [i + 1] }))}
                className="flex-1 min-w-0 flex items-center gap-3 pl-4 min-h-12 py-2 text-left"
              >
                <span className={cn('w-[22px] h-[22px] rounded-md border-2 flex items-center justify-center shrink-0', it.done ? 'bg-green-500 border-green-500' : 'border-muted-foreground/40')}>
                  {it.done && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                </span>
                <span className={cn('text-[16px]', it.done && 'line-through text-muted-foreground')}>{it.text}</span>
              </button>
              <button onClick={() => run(() => checklistAction(task.id, { remove: [it.id] }))} aria-label={`Delete ${it.text}`} className="w-11 h-11 shrink-0 flex items-center justify-center text-muted-foreground active:text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <form
            onSubmit={e => {
              e.preventDefault();
              if (!newItem.trim()) return;
              run(() => checklistAction(task.id, { add: [newItem.trim()] }));
              setNewItem('');
            }}
            className="flex items-center gap-3 px-4 h-12"
          >
            <Plus className="w-5 h-5 text-muted-foreground" />
            <input value={newItem} onChange={e => setNewItem(e.target.value)} enterKeyHint="done" placeholder="Add item" className="flex-1 bg-transparent text-[16px] outline-none" />
          </form>
        </div>
      </Field>

      {/* Description */}
      <Field label="Description">
        <textarea
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onBlur={() => desc !== task.description && patch({ description: desc })}
          rows={Math.min(8, Math.max(2, desc.split('\n').length))}
          placeholder="A line or two. Longer content goes in the note."
          className="w-full rounded-2xl border border-border/70 bg-card px-4 py-3 text-[16px] outline-none resize-none"
        />
      </Field>

      {/* Links */}
      <Field label="Links">
        <div className="rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
          {task.links.map((l, i) => (
            <div key={i} className="flex items-center">
              <a href={l.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 flex items-center gap-3 pl-4 h-12 active:bg-muted/60">
                <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="truncate text-[16px] text-blue-600 dark:text-blue-400">{l.label || l.url}</span>
              </a>
              <button onClick={() => patch({ links: task.links.filter((_, j) => j !== i) }, 'Link removed')} aria-label="Remove link" className="w-11 h-11 shrink-0 flex items-center justify-center text-muted-foreground active:text-red-500">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button onClick={() => setSheet('link')} className="w-full flex items-center gap-3 px-4 h-12 text-muted-foreground active:bg-muted/60">
            <Plus className="w-5 h-5" /> <span className="text-[16px]">Add link</span>
          </button>
        </div>
      </Field>

      {/* Dependencies */}
      <Field label="Dependencies">
        <div className="rounded-2xl border border-border/70 bg-card divide-y divide-border/60 overflow-hidden">
          {dependencies.map(d => (
            <DepRow key={`w${d.ref}`} d={d} label="Waits on" onRemove={() => patch({ dependsOn: task.dependsOn.filter(x => x !== d.id) }, 'Dependency removed')} />
          ))}
          {dependents.map(d => (
            <DepRow key={`b${d.ref}`} d={d} label="Blocks" />
          ))}
          <button onClick={() => setSheet('dep')} className="w-full flex items-center gap-3 px-4 h-12 text-muted-foreground active:bg-muted/60">
            <Plus className="w-5 h-5" /> <span className="text-[16px]">Waits on another task</span>
          </button>
        </div>
      </Field>

      {/* Comment + history */}
      <Field label="Comment">
        <form
          onSubmit={e => {
            e.preventDefault();
            if (!comment.trim()) return;
            run(() => addCommentAction(task.id, comment.trim()), 'Comment added');
            setComment('');
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={1}
            placeholder="What happened?"
            className="flex-1 rounded-2xl border border-border/70 bg-card px-4 py-3 text-[16px] outline-none resize-none"
          />
          <button disabled={!comment.trim() || pending} className="w-12 h-12 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-30" aria-label="Send">
            <Send className="w-5 h-5" />
          </button>
        </form>
      </Field>
      <Field label="History">
        <ActivityTimeline items={activity.slice(0, 40)} editable />
      </Field>

      {/* Sticky done */}
      {!closed && (
        <div className="fixed inset-x-0 z-30 px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 4.75rem)' }}>
          <button
            onClick={complete}
            disabled={pending}
            className="w-full h-14 rounded-2xl bg-green-600 text-white text-[17px] font-semibold shadow-lg shadow-green-900/20 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60"
          >
            <Check className="w-5 h-5" strokeWidth={3} /> Mark done
          </button>
        </div>
      )}

      {sheet === 'estimate' && (
        <TextSheet
          title="Estimate"
          label="Minutes"
          initial={task.estimateMins != null ? String(task.estimateMins) : ''}
          inputMode="numeric"
          placeholder="e.g. 45"
          presets={['15', '30', '60', '120']}
          clearable={task.estimateMins != null}
          onClose={() => setSheet(null)}
          onSave={v => {
            const n = v ? parseInt(v, 10) : null;
            if (n !== null && (!Number.isFinite(n) || n < 0)) return void toast.error('Enter minutes as a number');
            setSheet(null);
            patch({ estimateMins: n }, 'Estimate saved');
          }}
        />
      )}
      {sheet === 'tags' && (
        <TextSheet
          title="Tags"
          label="Comma separated"
          initial={task.tags.join(', ')}
          placeholder="design, client, urgent"
          clearable={task.tags.length > 0}
          onClose={() => setSheet(null)}
          onSave={v => {
            setSheet(null);
            patch({ tags: v.split(',').map(t => t.trim()).filter(Boolean) }, 'Tags saved');
          }}
        />
      )}
      {sheet === 'blocked' && (
        <TextSheet
          title="Blocked because"
          label="Reason"
          initial={task.blockedReason}
          placeholder="Waiting on client feedback, missing access…"
          onClose={() => setSheet(null)}
          onSave={v => {
            setSheet(null);
            patch({ blockedReason: v }, 'Reason saved');
          }}
        />
      )}
      {sheet === 'link' && (
        <TextSheet
          title="Add link"
          label="URL"
          initial=""
          inputMode="url"
          placeholder="Paste a URL"
          required
          onClose={() => setSheet(null)}
          onSave={v => {
            setSheet(null);
            patch({ links: [...task.links, v] }, 'Link added');
          }}
        />
      )}
      {sheet === 'dep' && (
        <TextSheet
          title="Waits on"
          label="Task number"
          initial=""
          inputMode="numeric"
          placeholder="e.g. 42"
          required
          onClose={() => setSheet(null)}
          onSave={v => {
            setSheet(null);
            patch({ dependsOn: [...task.dependsOn, v.replace(/^#/, '')] }, 'Dependency added');
          }}
        />
      )}
      {sheet === 'delete' && (
        <BottomSheet title={`Delete #${task.ref}?`} onClose={() => setSheet(null)}>
          <div className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">It moves to the trash and can be restored for 30 days.</p>
            <input
              value={delReason}
              onChange={e => setDelReason(e.target.value)}
              placeholder="Reason (optional)"
              enterKeyHint="done"
              className="w-full h-12 rounded-xl border border-border bg-card px-4 text-[16px] outline-none"
            />
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setSheet(null)} className="h-12 rounded-2xl border border-border text-[16px] font-medium active:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setSheet(null);
                  start(async () => {
                    const r = await deleteTaskAction(task.ref, delReason.trim() || undefined);
                    if (!r.ok) return void toast.error(r.error);
                    toast(`Moved #${task.ref} to trash`, { action: { label: 'Undo', onClick: () => void restoreTaskAction(task.ref).then(() => router.push(`/tasks/${task.ref}`)) } });
                    router.push('/today');
                  });
                }}
                className="h-12 rounded-2xl bg-red-600 text-white text-[16px] font-semibold disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        </BottomSheet>
      )}

      {progressOpen && <ProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="px-1 mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

function SelectRow({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 px-4 h-12">
      <span className="text-[16px] text-foreground w-20">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="flex-1 bg-transparent text-right text-[16px] text-muted-foreground outline-none appearance-none">
        {children}
      </select>
      <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
    </label>
  );
}

function DepRow({ d, label, onRemove }: { d: Dep; label: string; onRemove?: () => void }) {
  const done = d.status === 'Done' || d.status === 'Dropped';
  return (
    <div className="flex items-center">
      <Link href={`/tasks/${d.ref}`} className="flex-1 min-w-0 flex items-center gap-3 pl-4 h-12 active:bg-muted/60">
        <span className="text-[12px] text-muted-foreground w-16 shrink-0">{label}</span>
        <span className={cn('flex-1 truncate text-[15px]', done && 'line-through text-muted-foreground')}>
          #{d.ref} {d.title}
        </span>
      </Link>
      {onRemove ? (
        <button onClick={onRemove} aria-label={`Remove dependency #${d.ref}`} className="w-11 h-11 shrink-0 flex items-center justify-center text-muted-foreground active:text-red-500">
          <X className="w-4 h-4" />
        </button>
      ) : (
        <ChevronRight className="w-4 h-4 mr-4 text-muted-foreground/50" />
      )}
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
function recIdx(r: Recurrence | null): string {
  const i = RECURRENCE_OPTIONS.findIndex(o => JSON.stringify(o.value) === JSON.stringify(r));
  return i === -1 ? 'custom' : String(i);
}
function fmtMins(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** One full-width input in a bottom sheet (estimate, tags, reason, link, dependency). */
function TextSheet({
  title,
  label,
  initial,
  placeholder,
  inputMode,
  presets,
  required,
  clearable,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'url' | 'text';
  presets?: string[];
  required?: boolean;
  clearable?: boolean;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  const save = () => {
    const t = v.trim();
    if (required && !t) return;
    onSave(t);
  };
  return (
    <BottomSheet title={title} onClose={onClose}>
      <div className="space-y-3 pt-1">
        <label className="block">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
          <input
            autoFocus
            value={v}
            onChange={e => setV(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            inputMode={inputMode}
            placeholder={placeholder}
            enterKeyHint="done"
            autoCapitalize="none"
            className="mt-1 w-full h-12 rounded-xl border border-border bg-card px-4 text-[16px] outline-none"
          />
        </label>
        {presets && (
          <div className="flex gap-2">
            {presets.map(p => (
              <button key={p} type="button" onClick={() => setV(p)} className="flex-1 h-11 rounded-full border border-border text-[15px] active:bg-muted">
                {fmtMins(Number(p))}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          {clearable && (
            <button type="button" onClick={() => onSave('')} className="h-12 px-5 rounded-2xl border border-border text-[16px] text-muted-foreground active:bg-muted">
              Clear
            </button>
          )}
          <button type="button" onClick={save} disabled={required && !v.trim()} className="flex-1 h-12 rounded-2xl bg-foreground text-background text-[16px] font-semibold disabled:opacity-40">
            Save
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('w-full flex items-center gap-2 px-4 h-12 text-[15px] text-left active:bg-muted', danger && 'text-red-600 dark:text-red-400')}>
      {children}
    </button>
  );
}
