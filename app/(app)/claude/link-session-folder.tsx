'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import { Select } from '@/components/ui/select';
import { folderPickerAction, relinkFolderAction } from '../projects/[id]/launcher-actions';
import { write } from './auto-refresh';

/**
 * "Link to project" for a session whose folder no project owns (H13, "not filed"): the same picker and the same relinkFolder
 * as Claude › Setup › Computers › Folders, opened from the session's row. The folder is the one unlinked folder of that name
 * on the session's computer.
 */
export function LinkSessionFolder({ folderKey, deviceId, folder, onClose }: { folderKey: string; deviceId: string; folder: string; onClose: () => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    folderPickerAction(deviceId, '').then(r => {
      if (!alive) return;
      if (r.ok) setProjects(r.data.projects);
      else toast.error(r.error);
    });
    return () => {
      alive = false;
    };
  }, [deviceId]);

  const link = () =>
    start(async () => {
      const r = await write(() => relinkFolderAction(folderKey, pick));
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      toast(`Linked ${folder}`);
      onClose();
    });

  return (
    <ResponsiveSheet title="Link to project" onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2" data-link-session-folder>
        <p className="text-[16px] md:text-sm text-foreground">
          Which project is <strong>{folder}</strong> for? Sessions in it then check in to that project.
        </p>
        <Select value={pick} disabled={pending || !projects} aria-label={`Link ${folder} to project`} onChange={e => setPick(e.target.value)} className="h-11 md:h-10 w-full text-sm">
          <option value="">{projects ? 'Choose a project' : 'Loading…'}</option>
          {(projects ?? []).map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-medium border border-border text-foreground disabled:opacity-50" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-semibold bg-foreground text-background disabled:opacity-50" onClick={link} disabled={pending || !pick} data-confirm>
            Link
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
