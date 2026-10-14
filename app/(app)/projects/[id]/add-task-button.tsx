'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { QuickAddSheet } from '@/components/mobile/quick-add-sheet';

/** Phone: opens the capture sheet with this project preselected. */
export function AddTaskButton({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Add task to this project"
        className="w-11 h-11 rounded-full bg-foreground text-background flex items-center justify-center active:scale-95 transition-transform"
      >
        <Plus className="w-5 h-5" strokeWidth={2.4} />
      </button>
      <QuickAddSheet open={open} onClose={() => setOpen(false)} defaultProject={project} />
    </>
  );
}
