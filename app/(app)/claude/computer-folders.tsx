'use client';

import { useEffect, useState, useTransition } from 'react';
import { FolderGit2 } from 'lucide-react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/select';
import type { FolderView } from '@/lib/data/launcher';
import { folderPickerAction, relinkFolderAction } from '../projects/[id]/launcher-actions';

const NONE = '';

/**
 * One computer's folders, each with a "Link to project" picker (Claude › Setup › Computers). The same links as on a
 * project's Info › Code; choosing a project moves the folder there, "Not linked" takes it off its project.
 */
export function ComputerFolders({ deviceId }: { deviceId: string }) {
  const [folders, setFolders] = useState<FolderView[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = (text: string) =>
    folderPickerAction(deviceId, text).then(r => {
      if (!r.ok) return setError(r.error);
      setError(null);
      setFolders(r.data.folders);
      setProjects(r.data.projects);
    });
  useEffect(() => {
    let alive = true;
    folderPickerAction(deviceId, '').then(r => {
      if (!alive) return;
      if (!r.ok) return setError(r.error);
      setFolders(r.data.folders);
      setProjects(r.data.projects);
    });
    return () => {
      alive = false;
    };
  }, [deviceId]);

  const move = (f: FolderView, projectId: string) =>
    start(async () => {
      const r = await relinkFolderAction(f.key, projectId === NONE ? null : projectId);
      if (!r.ok) return void toast.error(r.error);
      toast(projectId === NONE ? `Unlinked ${f.name}` : `Linked ${f.name}`);
      await load(q);
    });

  return (
    <div className="px-4 pb-3 pt-1 space-y-2" data-computer-folders={deviceId}>
      <p className="text-[13px] text-muted-foreground">Folders this computer reported (names only). Pick the project a folder belongs to, so Claude can open sessions for it.</p>
      <input
        className="w-full h-10 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm outline-none focus-visible:border-ring"
        value={q}
        placeholder="Search folder names"
        aria-label="Search this computer's folders"
        onChange={e => {
          setQ(e.target.value);
          void load(e.target.value);
        }}
      />
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : !folders ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No folders yet. Is the worker running, and is the folder under one of its roots?</p>
      ) : (
        <div className="max-h-80 overflow-y-auto divide-y divide-border/60 rounded-xl border border-border/70">
          {folders.map(f => (
            <div key={f.key} className="flex flex-wrap items-center gap-2 px-3 py-2" data-computer-folder={f.name}>
              <FolderGit2 className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 basis-40 min-w-0">
                <div className="text-[14px] text-foreground truncate">{f.name}</div>
                {f.branch && <div className="text-[12px] text-muted-foreground truncate">branch {f.branch}</div>}
              </div>
              <Select
                value={f.projectId ?? NONE}
                disabled={pending}
                aria-label={`Link ${f.name} to project`}
                onChange={e => move(f, e.target.value)}
                className="h-10 w-full sm:w-52 text-sm"
              >
                <option value={NONE}>Not linked</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {f.projectId && !projects.some(p => p.id === f.projectId) && <option value={f.projectId}>Another project</option>}
              </Select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
