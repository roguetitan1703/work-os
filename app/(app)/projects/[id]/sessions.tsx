'use client';

import { Ago } from '@/components/ago';
import { useTransition } from 'react';
import { RotateCcw, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { FolderView, SessionView } from '@/lib/data/launcher';
import { stateText } from '@/lib/session-state';
import { removeSessionAction, resumeSessionAction, stopSessionAction } from './launcher-actions';
import { FolderLinks } from './folders';

const H2 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';
const card = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden';
const iconBtn = 'h-11 md:h-8 px-3 rounded-full inline-flex items-center justify-center gap-1 text-[13px] font-medium text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
/** Project page: folders linked on each computer, Start / Resume / Stop (docs/launcher.md). */
export function ProjectSessions({
  projectId,
  folders,
  suggestions,
  sessions,
  devices,
}: {
  projectId: string;
  folders: FolderView[];
  suggestions: FolderView[];
  sessions: SessionView[];
  devices: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      if (done) toast(done);
    });

    return (
    <section className="space-y-2" data-section="sessions">
      <div className="flex items-center justify-between">
        <h2 className={`${H2} px-1 md:px-0`}>Sessions and folders</h2>
      </div>

      <FolderLinks projectId={projectId} folders={folders} suggestions={suggestions} devices={devices} />

      {sessions.length > 0 && (
        <div className={`${card} divide-y divide-border/60`}>
          {sessions.map(s => {
            const st = stateText(s);
            const live = s.state === 'running' || s.state === 'starting';
            const ended = s.state === 'dead' || s.state === 'stopped' || s.state === 'failed';
            const canResume = s.linked && (ended || s.state === 'unknown');
            const canStop = live || s.state === 'unknown';
            const canRemove = ended || s.state === 'unknown';
            return (
            <div key={s.id} className="flex flex-wrap items-center gap-1 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-session={s.id}>
              <div className="flex-1 basis-40 min-w-0">
                <div className="text-[15px] md:text-sm text-foreground truncate">
                  {s.folderName} <span className="text-muted-foreground">· {s.deviceName}</span>
                </div>
                <div className="text-[13px] md:text-xs" suppressHydrationWarning>
                  <span className={st.tone}>{st.label}</span>
                  <span className="text-muted-foreground" suppressHydrationWarning>
                    {' '}· <Ago iso={s.startedAt} prefix="started " />
                  </span>
                  {s.error && <span className="text-muted-foreground"> · {s.error}</span>}
                </div>
              </div>
              {canResume && (
                <button type="button" className={iconBtn} disabled={pending} onClick={() => act(() => resumeSessionAction(projectId, s.id), 'Resuming…')} aria-label="Resume" title="Resume this session in its terminal">
                  <RotateCcw className="w-4 h-4" /> Resume
                </button>
              )}
              {canStop && (
                <button type="button" className={iconBtn} disabled={pending} onClick={() => act(() => stopSessionAction(projectId, s.id), 'Stopping…')} aria-label="Stop" title="Stop">
                  <Square className="w-4 h-4" /> Stop
                </button>
              )}
              {canRemove && (
                <button type="button" className={iconBtn} disabled={pending} onClick={() => act(() => removeSessionAction(projectId, s.id), 'Removed from the list')} aria-label="Remove" title="Remove from this list (history is kept)">
                  <Trash2 className="w-4 h-4" /> Remove
                </button>
              )}
            </div>
            );
          })}
        </div>
      )}

    </section>
  );
}
