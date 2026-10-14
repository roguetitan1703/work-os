'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import { deleteTaskAction, purgeTrashItemAction, restoreTaskAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** Restore a trashed task. Shows an Undo-style toast with a link to the task. */
export function useRestoreTask() {
  const router = useRouter();
  const [pending, start] = useTransition();
  function restore(ref: number, opts: { open?: boolean } = {}) {
    start(async () => {
      const res = await restoreTaskAction(ref);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Restored #${ref}`, opts.open ? undefined : { action: { label: 'Open', onClick: () => router.push(`/tasks/${ref}`) } });
      if (opts.open) router.push(`/tasks/${ref}`);
      router.refresh();
    });
  }
  return { restore, pending };
}

export function DeleteTaskButton({ taskRef, title }: { taskRef: number; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const { restore } = useRestoreTask();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await deleteTaskAction(taskRef, reason.trim() || undefined);
      if (!res.ok) return void toast.error(res.error);
      setOpen(false);
      toast.success(`Moved #${taskRef} to trash`, {
        duration: 10_000,
        action: { label: 'Undo', onClick: () => restore(taskRef, { open: true }) },
      });
      router.push('/today');
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" className="gap-1.5 h-8 max-md:h-11 max-md:px-4 max-md:text-sm text-muted-foreground hover:text-red-600 dark:hover:text-red-400" onClick={() => setOpen(true)}>
        <Trash2 className="w-3.5 h-3.5" /> Delete
      </Button>
      <Dialog open={open} onOpenChange={v => !pending && setOpen(v)}>
        <DialogContent className="max-w-md">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle className="text-sm">
                Delete <span className="font-mono">#{taskRef}</span>?
              </DialogTitle>
              <DialogDescription className="text-xs">
                <span className="text-foreground">{title}</span> and its history go to the trash for 30 days. You can restore it from History → Trash until then.
              </DialogDescription>
            </DialogHeader>
            <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" autoFocus />
            <DialogFooter className="sm:justify-end">
              <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" className="gap-1.5 max-md:h-11" disabled={pending}>
                <Trash2 className="w-3.5 h-3.5" /> Move to trash
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RestoreTrashButton({ taskRef, open: openAfter = false, size = 'xs' }: { taskRef: number; open?: boolean; size?: 'xs' | 'sm' }) {
  const { restore, pending } = useRestoreTask();
  return (
    <Button size={size} variant="outline" className="gap-1 max-md:h-11 max-md:flex-1 max-md:px-4 max-md:text-sm" disabled={pending} onClick={() => restore(taskRef, { open: openAfter })}>
      <RotateCcw className="w-3 h-3" /> Restore
    </Button>
  );
}

export function PurgeTrashButton({ taskRef, title }: { taskRef: number; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function purge() {
    start(async () => {
      const res = await purgeTrashItemAction(taskRef);
      if (!res.ok) return void toast.error(res.error);
      setOpen(false);
      toast.success(`#${taskRef} deleted forever`);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="xs" variant="ghost" className="max-md:h-11 max-md:flex-1 max-md:px-4 max-md:text-sm text-muted-foreground hover:text-red-600 dark:hover:text-red-400" onClick={() => setOpen(true)}>
        Delete forever
      </Button>
      <Dialog open={open} onOpenChange={v => !pending && setOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Delete <span className="font-mono">#{taskRef}</span> forever?
            </DialogTitle>
            <DialogDescription className="text-xs">
              <span className="text-foreground">{title}</span> and its history will be removed permanently. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-end">
            <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" className="max-md:h-11" onClick={purge} disabled={pending}>
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
