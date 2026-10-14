'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { logProgressAction } from '@/app/actions';
import type { Status, Task } from '@/lib/types';

export function ProgressDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const [progress, setProgress] = useState(task.progress);
  const [note, setNote] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const status: Status | undefined = blocked ? 'Blocked' : task.status === 'Blocked' ? 'In Progress' : undefined;
      const res = await logProgressAction(task.id, progress, note, status);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`#${task.ref} progress ${progress}%`);
      setNote('');
      onClose();
    });
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Log progress · <span className="text-muted-foreground font-normal">#{task.ref} {task.title}</span>
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Progress</span>
              <span className="font-mono text-foreground text-sm">{progress}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={e => setProgress(Number(e.target.value))}
              className="w-full accent-blue-500 max-md:h-8"
            />
            <div className="flex gap-1 max-md:gap-1.5">
              {[0, 25, 50, 75, 90].map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setProgress(v)}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted max-md:flex-1 max-md:min-h-11 max-md:text-sm max-md:font-medium max-md:text-foreground"
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>
          <Textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What moved? What's next?"
            rows={3}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground max-md:min-h-11 max-md:text-sm">
            <input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />
            Mark blocked (note explains why)
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Saving…' : 'Log'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
