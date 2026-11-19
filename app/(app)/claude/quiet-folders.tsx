'use client';

import { useEffect, useState, useTransition } from 'react';
import { FolderX, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { QuietFolder } from '@/lib/data/quiet-folders';
import { quietFoldersAction, removeQuietFolderAction } from '../projects/[id]/launcher-actions';

const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

/**
 * Claude › Setup › Computers, "Not Work OS folders": folders you told a Claude Code session are not Work OS (H13). Sessions in
 * them (and below) stay quiet. Remove puts a folder back: a session there asks which project it is for again. Hidden when empty.
 */
export function QuietFolders() {
  const [list, setList] = useState<QuietFolder[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    quietFoldersAction().then(r => alive && r.ok && setList(r.data));
    return () => {
      alive = false;
    };
  }, []);

  const remove = (f: QuietFolder) =>
    start(async () => {
      const r = await removeQuietFolderAction(f.machine, f.path);
      if (!r.ok) return void toast.error(r.error);
      setList(r.data);
      toast(`${f.path} will ask again`);
    });

  if (list.length === 0) return null;
  return (
    <div className="mt-4" data-quiet-folders={list.length}>
      <h3 className="text-sm font-semibold text-foreground">Not Work OS folders</h3>
      <p className="text-sm text-muted-foreground mb-3">Claude sessions in these folders (and below) do not ask which project they are for.</p>
      <div className="rounded-2xl border border-border/70 divide-y divide-border/60 bg-card overflow-hidden">
        {list.map(f => (
          <div key={`${f.machine}:${f.path}`} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14" data-quiet-folder={f.path}>
            <FolderX className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] md:text-sm text-foreground truncate">{f.path}</div>
              <div className="text-[13px] md:text-xs text-muted-foreground truncate">{f.machine}</div>
            </div>
            <button type="button" className={iconBtn} onClick={() => remove(f)} disabled={pending} aria-label={`Remove ${f.path}`} title="Remove">
              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
