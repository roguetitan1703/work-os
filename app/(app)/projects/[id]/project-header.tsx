'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateProjectAction } from '@/app/actions';
import { PROJECT_STATUSES, type Project, type ProjectInput } from '@/lib/types';
import { Textarea } from '@/components/ui/textarea';

export function ProjectHeader({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [client, setClient] = useState(project.client);
  const [description, setDescription] = useState(project.description);
  const [, start] = useTransition();

  function save(patch: Partial<ProjectInput>) {
    start(async () => {
      const res = await updateProjectAction(project.id, patch);
      if (res.ok) toast.success('Saved');
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && save({ name: name.trim() })}
          className="flex-1 bg-transparent text-2xl font-bold outline-none"
        />
        <select
          value={project.status}
          onChange={e => save({ status: e.target.value as Project['status'] })}
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
  );
}
