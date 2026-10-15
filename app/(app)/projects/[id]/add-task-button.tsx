'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { QuickAddSheet } from '@/components/mobile/quick-add-sheet';
import { QuickAddBar, HELP } from '@/components/quick-add';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePhone } from '@/components/mobile/use-phone';
import { cn } from '@/lib/utils';

/** "+ Task": capture sheet on phone, quick-add dialog on desktop, both preset to this project. */
export function AddTaskButton({ project, className }: { project: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-add-task
        className={cn('h-11 md:h-9 px-5 md:px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 border border-border bg-card text-foreground active:bg-muted hover:bg-muted/60', className)}
      >
        <Plus className="w-4 h-4" /> Task
      </button>
      {phone ? (
        <QuickAddSheet open={open} onClose={() => setOpen(false)} defaultProject={project} />
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-xl top-[20%] translate-y-0">
            <DialogHeader>
              <DialogTitle className="text-sm">New task in {project}</DialogTitle>
            </DialogHeader>
            {open && <QuickAddBar autoFocus defaults={{ project }} onCreated={() => setOpen(false)} />}
            <p className="text-[11px] text-muted-foreground">{HELP}</p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
