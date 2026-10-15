'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { FolderGit2, Link2, Play, Plus, RotateCcw, Square, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import type { FolderView, SessionView } from '@/lib/data/launcher';
import { ResponsiveSheet as Sheet } from '@/components/responsive-sheet';
import { stateText } from '@/lib/session-state';
import { fmtAgo } from '@/lib/format';
import { linkFolderAction, removeSessionAction, resumeSessionAction, searchFoldersAction, startSessionAction, stopSessionAction, unlinkFolderAction } from './launcher-actions';

const H2 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';
const card = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden';
const iconBtn = 'h-11 md:h-8 px-3 rounded-full inline-flex items-center justify-center gap-1 text-[13px] font-medium text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';
const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring';

const label = (f: FolderView) => `${f.name}${f.branch ? ` (${f.branch})` : ''}`;

/** Project page: folders linked on each computer, Start / Resume / Stop (docs/launcher.md). */
export function ProjectSessions({
  projectId,
  projectName,
  folders,
  suggestions,
  sessions,
  devices,
}: {
  projectId: string;
  projectName: string;
  folders: FolderView[];
  suggestions: FolderView[];
  sessions: SessionView[];
  devices: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [starting, setStarting] = useState<FolderView[] | null>(null);
  const [adding, setAdding] = useState(false);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      if (done) toast(done);
    });

    return (
    <section className="space-y-2" data-section="sessions">
      <div className="flex items-center justify-between">
        <h2 className={`${H2} px-1 md:px-0`}>Sessions</h2>
        {devices.length > 0 && (
          <Link href={`?start=${encodeURIComponent(projectId)}`} scroll={false} className={`${btn} bg-foreground text-background`} data-start-claude>
            <Play className="w-4 h-4" /> Start Claude
          </Link>
        )}
      </div>

      {!devices.length ? (
        <p className="text-sm text-muted-foreground px-1 md:px-0">
          Add a computer under{' '}
          <Link href="/claude?tab=setup" className="underline">
            Claude › Setup
          </Link>{' '}
          to start Claude Code sessions from here.
        </p>
      ) : (
        <div className={`${card} divide-y divide-border/60`}>
          {folders.map(f => (
            <div key={f.key} className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-folder={f.name}>
              <FolderGit2 className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className={`text-[15px] md:text-sm truncate ${f.missing ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{label(f)}</div>
                <div className="text-[13px] md:text-xs text-muted-foreground truncate">
                  {f.deviceName}
                  {f.missing ? ' · not found in its last scan' : f.online ? '' : ' · offline'}
                </div>
              </div>
              {!f.missing && (
                <button type="button" className={iconBtn} disabled={pending} onClick={() => setStarting([f])} aria-label={`Start in ${f.name}`} title="Start here">
                  <Play className="w-4 h-4" /> Start
                </button>
              )}
              <button type="button" className={iconBtn} disabled={pending} onClick={() => act(() => unlinkFolderAction(projectId, f.key), `Unlinked ${f.name}`)} aria-label={`Unlink ${f.name}`} title="Unlink">
                <Unlink className="w-4 h-4" /> Unlink
              </button>
            </div>
          ))}
          {suggestions.map(f => (
            <div key={f.key} className="flex items-center gap-2 pl-4 md:pl-3 pr-2 py-1.5 min-h-14 md:min-h-11 bg-muted/30" data-suggestion={f.name}>
              <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] md:text-sm text-foreground truncate">{label(f)}</div>
                <div className="text-[13px] md:text-xs text-muted-foreground truncate">{f.deviceName} · same repo as this project</div>
              </div>
              <button type="button" className={`${btn} border border-border`} disabled={pending} onClick={() => act(() => linkFolderAction(projectId, f.key), `Linked ${f.name}`)}>
                Link
              </button>
            </div>
          ))}
          <button type="button" className="w-full flex items-center gap-2 px-4 md:px-3 min-h-12 md:min-h-10 text-sm text-muted-foreground hover:bg-muted/40 active:bg-muted/60" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4" /> Add a folder
          </button>
        </div>
      )}

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
                    {' '}· started {fmtAgo(s.startedAt)}
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

      {starting && (
        <StartSheet
          projectName={projectName}
          folders={starting}
          pending={pending}
          onClose={() => setStarting(null)}
          onStart={(f, prompt) =>
            start(async () => {
              const r = await startSessionAction(projectId, f.key, prompt);
              if (!r.ok) return void toast.error(r.error);
              setStarting(null);
              toast(`Starting ${projectName} on ${f.deviceName}. It appears in the Claude app in a few seconds.`);
            })
          }
        />
      )}
      {adding && <AddFolderSheet projectId={projectId} devices={devices} onClose={() => setAdding(false)} />}
    </section>
  );
}

function StartSheet({ projectName, folders, pending, onClose, onStart }: { projectName: string; folders: FolderView[]; pending: boolean; onClose: () => void; onStart: (f: FolderView, prompt: string) => void }) {
  const [pick, setPick] = useState(folders[0]?.key);
  const [prompt, setPrompt] = useState('');
  const f = folders.find(x => x.key === pick) ?? folders[0];
  return (
    <Sheet title={`Start ${projectName}`} onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2">
        {folders.length > 1 && (
          <div className="space-y-1.5" role="radiogroup" aria-label="Folder">
            {folders.map(x => (
              <label key={x.key} className="flex items-center gap-3 min-h-12 px-3 rounded-xl border border-border has-[:checked]:border-foreground cursor-pointer">
                <input type="radio" name="folder" checked={pick === x.key} onChange={() => setPick(x.key)} className="w-4 h-4" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] truncate">{label(x)}</span>
                  <span className="block text-[13px] text-muted-foreground">{x.deviceName}{x.online ? '' : ' · offline'}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {folders.length === 1 && (
          <p className="text-[15px]">
            {label(f)} <span className="text-muted-foreground">on {f.deviceName}</span>
          </p>
        )}
        <div className="space-y-1">
          <textarea
            className={`${field} h-24 py-2 resize-none`}
            value={prompt}
            maxLength={4000}
            onChange={e => setPrompt(e.target.value)}
            placeholder="First message (optional). Usually leave empty and type in the Claude app."
            aria-label="First message"
          />
          <p className="text-[12px] text-muted-foreground">Opens Claude Code in that folder, in normal permission mode, connected to the Claude app.</p>
        </div>
        <button type="button" className={`${btn} w-full bg-foreground text-background`} disabled={pending || !f} onClick={() => f && onStart(f, prompt)}>
          <Play className="w-4 h-4" /> Start
        </button>
      </div>
    </Sheet>
  );
}

function AddFolderSheet({ projectId, devices, onClose }: { projectId: string; devices: { id: string; name: string }[]; onClose: () => void }) {
  const [device, setDevice] = useState(devices[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [list, setList] = useState<FolderView[] | null>(null);
  const [pending, start] = useTransition();
  const search = (d = device, text = q) =>
    start(async () => {
      const r = await searchFoldersAction(d, text);
      if (!r.ok) return void toast.error(r.error);
      setList(r.data);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void (device && search()), []);
  return (
    <Sheet title="Add a folder" onClose={onClose}>
      <div className="space-y-3 pt-1 pb-2">
        {devices.length > 1 && (
          <select
            className={field}
            value={device}
            onChange={e => {
              setDevice(e.target.value);
              search(e.target.value);
            }}
            aria-label="Computer"
          >
            {devices.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <input
          className={field}
          value={q}
          onChange={e => {
            setQ(e.target.value);
            search(device, e.target.value);
          }}
          placeholder="Search folder names"
          aria-label="Search folder names"
        />
        <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-border divide-y divide-border/60">
          {!list ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">No folders match. Is the worker running and is the folder under one of its roots?</p>
          ) : (
            list.map(f => (
              <button
                key={f.key}
                type="button"
                className="w-full text-left flex items-center gap-2 px-3 min-h-12 hover:bg-muted/40 active:bg-muted/60 disabled:opacity-50"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await linkFolderAction(projectId, f.key);
                    if (!r.ok) return void toast.error(r.error);
                    toast(`Linked ${f.name}`);
                    onClose();
                  })
                }
              >
                <FolderGit2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] md:text-sm truncate">{label(f)}</span>
                  {f.remote && <span className="block text-[12px] text-muted-foreground truncate">{f.remote}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </Sheet>
  );
}
