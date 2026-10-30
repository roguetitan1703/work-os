'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createTaskAction } from '@/app/actions';
import { RECURRENCE_OPTIONS } from '@/lib/recurrence-options';
import { PRIORITIES, STATUSES, type Mode, type Priority, type Status, type TaskInput } from '@/lib/types';
import { useApp, useModes } from './app-context';
import { Select } from '@/components/ui/select';

const field = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring dark:bg-input/30';

type Props = {
  open: boolean;
  onClose: () => void;
  initial?: Partial<TaskInput>;
};

export function TaskForm({ open, onClose, initial }: Props) {
  const { projects } = useApp();
  const { modes, color } = useModes();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    project: initial?.project ?? '',
    mode: (initial?.mode ?? '') as Mode | '',
    priority: (initial?.priority ?? 'P2') as Priority,
    status: (initial?.status ?? 'Not Started') as Status,
    due: initial?.due ?? '',
    start: initial?.start ?? '',
    estimateMins: initial?.estimateMins?.toString() ?? '',
    tags: initial?.tags?.join(', ') ?? '',
    checklist: '',
    links: '',
    repeat: '0',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));

  function submit(e: React.FormEvent, openAfter = false) {
    e.preventDefault();
    const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);
    const input: TaskInput = {
      title: f.title,
      description: f.description,
      project: f.project.trim() || null,
      mode: f.mode || null,
      priority: f.priority,
      status: f.status,
      due: f.due || null,
      start: f.start || null,
      estimateMins: f.estimateMins ? parseInt(f.estimateMins, 10) : null,
      tags: f.tags.split(',').map(t => t.trim()).filter(Boolean),
      checklist: lines(f.checklist),
      links: lines(f.links),
      recurrence: RECURRENCE_OPTIONS[Number(f.repeat)]?.value ?? null,
    };
    start(async () => {
      const res = await createTaskAction(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Created #${res.data.ref}`);
      onClose();
      if (openAfter) router.push(`/tasks/${res.data.ref}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input value={f.title} onChange={e => set('title', e.target.value)} placeholder="Title" required autoFocus />
          <Textarea value={f.description} onChange={e => set('description', e.target.value)} placeholder="Description, context, acceptance criteria…" rows={4} />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Project / client</Label>
              <input list="project-options" className={field} value={f.project} onChange={e => set('project', e.target.value)} placeholder="New or existing" />
              <datalist id="project-options">
                {projects.map(p => (
                  <option key={p.id} value={p.name} label={p.visibility === 'private' ? 'Private' : undefined} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kind of work</Label>
              <Select className={field} value={f.mode} onChange={e => set('mode', e.target.value as Mode | '')}>
                <option value="">—</option>
                {modes.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Priority</Label>
              <Select className={field} value={f.priority} onChange={e => set('priority', e.target.value as Priority)}>
                {PRIORITIES.map(p => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1 col-span-1">
              <Label className="text-xs">Status</Label>
              <Select className={field} value={f.status} onChange={e => set('status', e.target.value as Status)}>
                {STATUSES.map(s => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start</Label>
              <input type="date" className={field} value={f.start} onChange={e => set('start', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Due</Label>
              <input type="date" className={field} value={f.due} onChange={e => set('due', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Repeats</Label>
              <Select className={field} value={f.repeat} onChange={e => set('repeat', e.target.value)}>
                {RECURRENCE_OPTIONS.map((o, i) => (
                  <option key={i} value={i}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Estimate (min)</Label>
              <input type="number" min={0} className={field} value={f.estimateMins} onChange={e => set('estimateMins', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tags (comma separated)</Label>
              <input className={field} value={f.tags} onChange={e => set('tags', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Checklist (one per line)</Label>
              <Textarea value={f.checklist} onChange={e => set('checklist', e.target.value)} rows={3} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Links (one per line)</Label>
              <Textarea value={f.links} onChange={e => set('links', e.target.value)} rows={3} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" variant="outline" disabled={pending || !f.title.trim()} onClick={e => submit(e, true)}>
              Create &amp; open
            </Button>
            <Button type="submit" disabled={pending || !f.title.trim()}>
              {pending ? 'Saving…' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
