'use client';

import { useState, useTransition } from 'react';
import { FolderGit2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { updateProjectAction } from '@/app/actions';
import type { CodeLocation } from '@/lib/types';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';

const EMPTY: CodeLocation = { remote: '', subdir: '', branch: '', path: '' };

function label(l: CodeLocation): { main: string; sub: string } {
  const main = l.remote ?? l.path ?? '';
  const sub = [l.remote && l.path ? l.path : '', l.subdir ? `folder ${l.subdir}` : '', l.branch ? `branch ${l.branch}` : ''].filter(Boolean).join(' · ');
  return { main, sub };
}

/** Where the project's code lives; Claude Code uses it to find the project from a repo (get_project with remote/subdir/branch). */
export function CodeLocations({ projectId, initial }: { projectId: string; initial: CodeLocation[] }) {
  const [list, setList] = useState<CodeLocation[]>(initial);
  const [draft, setDraft] = useState<CodeLocation | null>(null);
  const [pending, start] = useTransition();

  const save = (next: CodeLocation[], after?: () => void) =>
    start(async () => {
      const r = await updateProjectAction(projectId, { code: next });
      if (!r.ok) return void toast.error(r.error);
      setList(r.data.code ?? []);
      after?.();
    });

  const add = () => {
    if (!draft) return;
    const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => typeof v === 'string' && v.trim())) as CodeLocation;
    if (!clean.remote && !clean.path) return void toast.error('Add a git remote or a folder path');
    save([...list, clean], () => setDraft(null));
  };

  const set = (k: keyof CodeLocation) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft(d => ({ ...(d ?? EMPTY), [k]: e.target.value }));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 md:px-0">Repos</h2>
        {!draft && (
          <button type="button" onClick={() => setDraft(EMPTY)} className="h-11 md:h-7 px-3 md:px-2 inline-flex items-center gap-1 text-sm md:text-xs text-muted-foreground hover:text-foreground rounded-xl md:rounded-md active:bg-muted">
            <Plus className="w-4 h-4 md:w-3.5 md:h-3.5" /> Add
          </button>
        )}
      </div>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border divide-y divide-border/60 md:divide-border bg-card overflow-hidden">
        {list.map((l, i) => {
          const t = label(l);
          return (
            <div key={i} className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11">
              <FolderGit2 className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] md:text-sm font-mono truncate">{t.main}</div>
                {t.sub && <div className="text-[13px] md:text-xs text-muted-foreground truncate">{t.sub}</div>}
              </div>
              <button
                type="button"
                onClick={() => save(list.filter((_, j) => j !== i))}
                disabled={pending}
                aria-label={`Remove ${t.main}`}
                className="w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
        {!list.length && !draft && (
          <p className="px-4 md:px-3 py-3 text-sm md:text-xs text-muted-foreground">No repos linked. Claude Code uses these to find this project from the repo it is working in.</p>
        )}
        {draft && (
          <div className="p-3 space-y-2">
            <input className={field} value={draft.remote} onChange={set('remote')} placeholder="Git remote, e.g. owner/repo or its URL" aria-label="Git remote" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <div className="grid grid-cols-2 gap-2">
              <input className={field} value={draft.subdir} onChange={set('subdir')} placeholder="Folder (optional)" aria-label="Folder inside the repo" autoCapitalize="off" spellCheck={false} />
              <input className={field} value={draft.branch} onChange={set('branch')} placeholder="Branch (optional)" aria-label="Branch" autoCapitalize="off" spellCheck={false} />
            </div>
            <input className={field} value={draft.path} onChange={set('path')} placeholder="Or a folder path, e.g. D:\Work\client" aria-label="Folder path" autoCapitalize="off" spellCheck={false} />
            <div className="flex gap-2">
              <button type="button" className={`${btn} flex-1 border border-border text-foreground font-medium`} onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" className={`${btn} flex-1 bg-foreground text-background`} onClick={add} disabled={pending}>
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
