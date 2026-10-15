'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { updateProjectAction } from '@/app/actions';
import { PROJECT_STATUSES, type Project, type ProjectInput } from '@/lib/types';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Info tab: the details form (name, client, status, Description). */
export function ProjectDetails({ project }: { project: Project }) {
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState(project.status);
  const [, start] = useTransition();

  function save(patch: Partial<ProjectInput>) {
    start(async () => {
      const res = await updateProjectAction(project.id, patch);
      if (res.ok) {
        toast.success('Saved');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <section className="space-y-2" data-section="details">
      <h2 className="text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 md:px-0">Details</h2>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card p-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Name</span>
          <input className={field} value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== project.name && save({ name: name.trim() })} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Client</span>
          <input className={field} value={client} placeholder="None" onChange={e => setClient(e.target.value)} onBlur={() => client !== project.client && save({ client })} />
        </label>
        <div className="space-y-1">
          <div className="text-sm text-muted-foreground">Status</div>
          <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Project status">
            {PROJECT_STATUSES.map(s => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                onClick={() => {
                  if (status === s) return;
                  setStatus(s);
                  save({ status: s });
                }}
                className={cn('h-11 md:h-9 rounded-lg text-sm font-medium capitalize', status === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Description</span>
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            onBlur={() => description !== project.description && save({ description })}
            placeholder="Scope, links, anything to remember…"
            rows={4}
            className="text-[16px] md:text-sm"
          />
        </label>
      </div>
    </section>
  );
}
