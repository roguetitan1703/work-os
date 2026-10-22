'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from '@/components/intent-link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronLeft, MoreHorizontal, Pencil, Archive, Play } from 'lucide-react';
import { toast } from 'sonner';
import { updateProjectAction } from '@/app/actions';
import { BackLink } from '@/components/back-link';
import { ConfirmSheet, ResponsiveSheet } from '@/components/responsive-sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { PROJECT_STATUSES, type Project, type ProjectInput } from '@/lib/types';
import { AddTaskButton } from './add-task-button';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Back, name / client / status (editable here), the ⋯ menu, and the two first-screen buttons. */
export function ProjectTop({ project, tab }: { project: Project; tab: string }) {
  const router = useRouter();
  const phone = usePhone();
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client);
  const [status, setStatus] = useState(project.status);
  const [sheet, setSheet] = useState(false);
  const [menu, setMenu] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [, start] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const save = (patch: Partial<ProjectInput>, done = 'Saved', after?: () => void) =>
    start(async () => {
      const res = await updateProjectAction(project.id, patch);
      if (!res.ok) return void toast.error(res.error);
      toast.success(done);
      after?.();
      router.refresh();
    });

  const edit = () => {
    setMenu(false);
    if (phone) setSheet(true);
    else nameRef.current?.focus();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between -mx-2 md:mx-0">
        <BackLink href="/projects" aria-label="Back to Projects" className="inline-flex items-center h-11 md:h-8 pl-1 pr-3 gap-0.5 rounded-xl text-[16px] md:text-xs text-blue-600 dark:text-blue-400 md:text-muted-foreground md:hover:text-foreground active:opacity-60">
          <ChevronLeft className="w-6 h-6 md:hidden" strokeWidth={2.2} />
          <ArrowLeft className="w-3 h-3 hidden md:inline mr-1" />
          Projects
        </BackLink>
        <div className="relative" ref={menuRef}>
          <button type="button" aria-label="Project menu" aria-expanded={menu} onClick={() => setMenu(v => !v)} data-project-menu className="w-11 h-11 md:w-8 md:h-8 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted hover:bg-muted/60">
            <MoreHorizontal className="w-5 h-5" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 top-full z-50 w-44 rounded-xl border border-border bg-popover shadow-lg p-1">
              <button role="menuitem" type="button" onClick={edit} className="w-full flex items-center gap-2 px-3 min-h-11 md:min-h-9 rounded-lg text-sm text-left hover:bg-muted">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(false);
                  setArchiving(true);
                }}
                disabled={status === 'archived'}
                className="w-full flex items-center gap-2 px-3 min-h-11 md:min-h-9 rounded-lg text-sm text-left hover:bg-muted disabled:opacity-50"
              >
                <Archive className="w-4 h-4" /> Archive
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Phone: one tap target opens the edit sheet. */}
      <button type="button" onClick={() => setSheet(true)} data-edit-header aria-label="Edit name, client and status" className="md:hidden block w-full text-left min-w-0 active:opacity-70">
        <span className="block text-2xl font-bold text-foreground truncate">{project.name}</span>
        <span className="block text-[16px] text-muted-foreground truncate">
          {project.client ? `${project.client} · ` : ''}
          <span className="capitalize">{project.status}</span>
        </span>
      </button>

      {/* Desktop: inline. */}
      <div className="hidden md:block space-y-1">
        <div className="flex items-center gap-3">
          <input
            ref={nameRef}
            value={name}
            aria-label="Project name"
            onChange={e => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== project.name && save({ name: name.trim() })}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
            className="flex-1 min-w-0 bg-transparent text-2xl font-bold outline-none rounded-md px-1 -mx-1 hover:bg-muted/40 focus:bg-muted/40"
          />
          <select
            value={status}
            aria-label="Project status"
            onChange={e => {
              const s = e.target.value as Project['status'];
              setStatus(s);
              save({ status: s });
            }}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          >
            {PROJECT_STATUSES.map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <input
          value={client}
          aria-label="Client"
          onChange={e => setClient(e.target.value)}
          onBlur={() => client !== project.client && save({ client })}
          onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          placeholder="Client"
          className="w-full bg-transparent text-sm text-muted-foreground outline-none rounded-md px-1 -mx-1 hover:bg-muted/40 focus:bg-muted/40"
        />
      </div>

      <div className="flex gap-2">
        <Link
          href={`/projects/${encodeURIComponent(project.id)}?tab=${tab}&start=${encodeURIComponent(project.id)}`}
          scroll={false}
          data-start-claude
          className="flex-1 md:flex-none h-11 md:h-9 px-5 md:px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 bg-foreground text-background"
        >
          <Play className="w-4 h-4" /> Start Claude
        </Link>
        <AddTaskButton project={project.name} className="flex-1 md:flex-none" />
      </div>

      {sheet && <EditSheet project={project} onClose={() => setSheet(false)} onSave={patch => save(patch, 'Saved', () => setSheet(false))} />}
      {archiving && (
        <ConfirmSheet
          title="Archive project"
          message={<>Archive {project.name}? It leaves the active list; its tasks and notes are kept.</>}
          verb="Archive"
          onClose={() => setArchiving(false)}
          onConfirm={() => save({ status: 'archived' }, 'Archived', () => router.push('/projects'))}
        />
      )}
    </div>
  );
}

function EditSheet({ project, onClose, onSave }: { project: Project; onClose: () => void; onSave: (p: Partial<ProjectInput>) => void }) {
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client);
  const [status, setStatus] = useState(project.status);
  return (
    <ResponsiveSheet title="Edit project" onClose={onClose}>
      <div className="space-y-3 pt-1 pb-2">
        <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="Name" aria-label="Edit name" />
        <input className={field} value={client} onChange={e => setClient(e.target.value)} placeholder="Client" aria-label="Edit client" />
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Status">
          {PROJECT_STATUSES.map(s => (
            <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)} className={`h-11 rounded-lg text-sm font-medium capitalize ${status === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              {s}
            </button>
          ))}
        </div>
        <button type="button" disabled={!name.trim()} data-save-header className="w-full h-11 rounded-full text-sm font-semibold bg-foreground text-background disabled:opacity-50" onClick={() => onSave({ name: name.trim(), client, status })}>
          Save
        </button>
      </div>
    </ResponsiveSheet>
  );
}
