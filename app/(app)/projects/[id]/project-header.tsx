'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateProjectAction } from '@/app/actions';
import { PROJECT_STATUSES, type Project, type ProjectInput } from '@/lib/types';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function ProjectHeader({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState(project.status);
  const [, start] = useTransition();

  function save(patch: Partial<ProjectInput>) {
    start(async () => {
      const res = await updateProjectAction(project.id, patch);
      if (res.ok) toast.success('Saved');
      else toast.error(res.error);
    });
  }

  function setProjectStatus(s: Project['status']) {
    setStatus(s);
    save({ status: s });
  }

  return (
    <>
      {/* Phone: the title lives in the sticky header, so this is a details card. */}
      <div className="md:hidden rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
        <label className="flex items-center gap-3 px-4 min-h-12">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => name.trim() && name !== project.name && save({ name: name.trim() })}
            enterKeyHint="done"
            className="flex-1 min-w-0 h-12 bg-transparent text-[16px] outline-none"
          />
        </label>
        <label className="flex items-center gap-3 px-4 min-h-12">
          <span className="w-20 shrink-0 text-sm text-muted-foreground">Client</span>
          <input
            value={client}
            onChange={e => setClient(e.target.value)}
            onBlur={() => client !== project.client && save({ client })}
            placeholder="None"
            enterKeyHint="done"
            className="flex-1 min-w-0 h-12 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/50"
          />
        </label>
        <div className="px-4 py-3">
          <div className="text-sm text-muted-foreground mb-2">Status</div>
          <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Project status">
            {PROJECT_STATUSES.map(s => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                onClick={() => status !== s && setProjectStatus(s)}
                className={cn(
                  'h-11 rounded-lg text-sm font-medium capitalize transition-colors active:scale-95',
                  status === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="px-4 py-3">
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            onBlur={() => description !== project.description && save({ description })}
            placeholder="Project notes, scope, links…"
            rows={3}
            className="border-0 bg-transparent dark:bg-transparent px-0 text-[16px] shadow-none focus-visible:ring-0"
          />
        </div>
      </div>

      <div className="hidden md:block space-y-2">
        <div className="flex items-center gap-3">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => name.trim() && name !== project.name && save({ name: name.trim() })}
            className="flex-1 bg-transparent text-2xl font-bold outline-none"
          />
          <select
            value={status}
            onChange={e => setProjectStatus(e.target.value as Project['status'])}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          >
            {PROJECT_STATUSES.map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <input
          value={client}
          onChange={e => setClient(e.target.value)}
          onBlur={() => client !== project.client && save({ client })}
          placeholder="Client"
          className="w-full bg-transparent text-sm text-muted-foreground outline-none"
        />
        <Textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          onBlur={() => description !== project.description && save({ description })}
          placeholder="Project notes, scope, links…"
          rows={2}
        />
      </div>
    </>
  );
}
