'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowUp, FilePlus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { createNoteAction } from '@/app/(app)/notes/actions';
import { cn } from '@/lib/utils';
import { BottomSheet } from './sheet';

type P = { id: string; name: string };

/** Phone filters for the notes list: live search and swipeable chips (no Filter button). */
export function MobileNoteFilters({ projects }: { projects: P[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [, start] = useTransition();
  const state = sp.get('state') ?? 'active';
  const kind = sp.get('kind') ?? 'all';
  const project = sp.get('project') ?? '';

  const go = (patch: Record<string, string>) => {
    // Read the live URL: a debounced search can fire after a chip tap, and a stale `sp` would undo it.
    const u = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (!v || (k === 'state' && v === 'active') || (k === 'kind' && v === 'all')) u.delete(k);
      else u.set(k, v);
    }
    const s = u.toString();
    start(() => router.replace(s ? `${path}?${s}` : path, { scroll: false }));
  };

  // Search as you type (debounced).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => go({ q: q.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="md:hidden space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search notes"
          enterKeyHint="search"
          className="w-full h-11 rounded-xl bg-muted/70 pl-9 pr-9 text-[16px] outline-none placeholder:text-muted-foreground"
        />
        {q && (
          <button onClick={() => setQ('')} aria-label="Clear" className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(['active', 'archived', 'all'] as const).map(s => (
          <Chip key={s} on={state === s} onClick={() => go({ state: s })}>
            {s === 'active' ? 'Active' : s === 'archived' ? 'Archived' : 'All'}
          </Chip>
        ))}
        <span className="w-px shrink-0 bg-border my-1.5" />
        <Chip on={kind === 'task'} onClick={() => go({ kind: kind === 'task' ? 'all' : 'task' })}>
          Task notes
        </Chip>
        <Chip on={kind === 'project'} onClick={() => go({ kind: kind === 'project' ? 'all' : 'project' })}>
          Project notes
        </Chip>
      </div>
      {projects.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip on={!project} onClick={() => go({ project: '' })}>
            All projects
          </Chip>
          {projects.map(p => (
            <Chip key={p.id} on={project === p.id} onClick={() => go({ project: project === p.id ? '' : p.id })}>
              {p.name}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

/** "+ New" in the Notes header: opens a bottom sheet with a title and project chips. */
export function NewNoteSheetButton({ projects, defaultProject }: { projects: P[]; defaultProject?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="New note" type="button" className="h-11 min-w-11 px-4 rounded-full bg-foreground text-background text-sm font-semibold flex items-center justify-center gap-1.5 touch-manipulation active:opacity-80">
        <FilePlus className="w-4 h-4" /> New
      </button>
      {open && <NewNoteSheet projects={projects} defaultProject={defaultProject} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewNoteSheet({ projects, defaultProject, onClose }: { projects: P[]; defaultProject?: string; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(defaultProject && projects.some(p => p.id === defaultProject) ? defaultProject : (projects[0]?.id ?? ''));
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const create = () =>
    start(async () => {
      if (!project) return void toast.error('Pick a project');
      const r = await createNoteAction({ project, title: title.trim() || 'Untitled' });
      if ('error' in r) return void toast.error(r.error);
      onClose();
      router.push(`/notes/${r.id}?new=1`);
    });

  return (
    <BottomSheet title="New note" onClose={onClose}>
      <input
        ref={input}
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && create()}
        placeholder="Title"
        enterKeyHint="go"
        className="w-full bg-transparent text-xl text-foreground outline-none placeholder:text-muted-foreground/50 py-2"
      />
      {projects.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
          A note has to live inside a project or a task, and there are no projects yet.{' '}
          <Link href="/projects" onClick={onClose} className="font-medium text-foreground underline">
            Create a project
          </Link>{' '}
          first, or open a task and tap &ldquo;Add a note&rdquo;.
        </div>
      ) : (
        <>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Project</div>
          <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
            {projects.map(p => (
              <Chip key={p.id} on={project === p.id} onClick={() => setProject(p.id)}>
                {p.name}
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Notes are filed under a project. For a task&apos;s note, open the task.</p>
        </>
      )}
      <div className="pt-3">
        <button type="button" onClick={create} disabled={pending || !project} className="w-full h-12 rounded-2xl bg-foreground text-background text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-40">
          <ArrowUp className="w-5 h-5" /> {pending ? 'Creating…' : 'Create note'}
        </button>
      </div>
    </BottomSheet>
  );
}

function Chip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 h-11 px-4 rounded-full border text-sm font-medium whitespace-nowrap',
        on ? 'bg-foreground text-background border-foreground' : 'border-border text-foreground bg-background',
      )}
    >
      {children}
    </button>
  );
}
