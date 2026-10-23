'use client';

import { privateSuffix } from '@/components/private-badge';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus } from 'lucide-react';
import { toast } from 'sonner';
import { createNoteAction } from '@/app/(app)/notes/actions';
import { cn } from '@/lib/utils';

/**
 * New note. With `task`, opens (or creates) that task's note. With `project`, creates a project note.
 * With `projects`, asks which project first.
 */
export function NewNoteButton({
  task,
  project,
  projects,
  defaultProject,
  label,
  className,
}: {
  task?: number;
  project?: string;
  projects?: { id: string; name: string; private?: boolean }[];
  defaultProject?: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState(defaultProject ?? projects?.[0]?.id ?? '');
  const [title, setTitle] = useState('');

  const create = (input: { task?: number; project?: string; title?: string }) =>
    start(async () => {
      const r = await createNoteAction(input);
      if ('error' in r) toast.error(r.error);
      else router.push(`/notes/${r.id}?edit=1`);
    });

  if (projects && picking) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={e => {
          e.preventDefault();
          create({ project: pick, title: title.trim() || 'Untitled' });
        }}
      >
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="h-9 w-48 rounded-md border border-border bg-background px-3 text-sm" />
        <select value={pick} onChange={e => setPick(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          {projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}{privateSuffix(p.private)}
            </option>
          ))}
        </select>
        <button disabled={pending || !pick} className="h-9 px-3 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50">
          Create
        </button>
        <button type="button" onClick={() => setPicking(false)} className="h-9 px-2 text-sm text-muted-foreground">
          Cancel
        </button>
      </form>
    );
  }

  return (
    <button
      disabled={pending}
      onClick={() => (projects ? setPicking(true) : create({ task, project, title: task ? undefined : 'Untitled' }))}
      className={cn(
        'inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background text-sm font-medium hover:bg-muted disabled:opacity-50',
        className,
      )}
    >
      <FilePlus className="w-4 h-4" />
      {label ?? 'New note'}
    </button>
  );
}
