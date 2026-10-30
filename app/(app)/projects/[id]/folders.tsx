"use client";

import { useEffect, useState, useTransition } from 'react';
import Link from '@/components/intent-link';
import { FolderGit2, Link2, Plus, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Ago } from '@/components/ago';
import type { FolderView } from '@/lib/data/launcher';
import { ConfirmSheet, ResponsiveSheet as Sheet } from '@/components/responsive-sheet';
import { Select } from '@/components/ui/select';
import type { TurboInfo } from '@/lib/data/turbo';
import { linkFolderAction, searchFoldersAction, unlinkFolderAction } from './launcher-actions';

const card = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden';
const iconBtn = 'h-11 md:h-8 px-3 rounded-full inline-flex items-center justify-center gap-1 text-[13px] font-medium text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';
const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring';

const label = (f: FolderView) => `${f.name}${f.branch ? ` (${f.branch})` : ''}`;

/**
 * The folders on the person's computers that belong to this project (docs/launcher.md): grouped by computer, each with its
 * branch, Unlink (asks first), suggestions with the same repo, and Link folder. Shown on the project's Info tab and on its
 * Claude tab.
 */
export function FolderLinks({ projectId, folders, suggestions, devices, turbo }: { projectId: string; folders: FolderView[]; suggestions: FolderView[]; devices: { id: string; name: string }[]; turbo?: TurboInfo }) {
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [unlinking, setUnlinking] = useState<FolderView | null>(null);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      if (done) toast(done);
    });

  if (!devices.length) {
    return (
      <p className="text-sm text-muted-foreground px-1 md:px-0">
        Add a computer under{' '}
        <Link href="/claude?tab=setup" className="underline">
          Claude › Setup
        </Link>{' '}
        to start Claude Code sessions from here.
      </p>
    );
  }
  const byDevice = devices.map(d => ({ d, rows: folders.filter(f => f.deviceId === d.id) })).filter(g => g.rows.length);
  return (
    <>
      <div className={`${card} divide-y divide-border/60`} data-folder-links>
        {byDevice.map(({ d, rows }) => (
          <div key={d.id} data-device-group={d.name}>
            <div className="flex items-center gap-2 px-4 md:px-3 pt-2 pb-0.5 text-[12px] text-muted-foreground">
              <span className={`w-2 h-2 rounded-full shrink-0 ${rows[0].online ? 'bg-green-500' : 'bg-muted-foreground/40'}`} aria-hidden />
              <span className="font-medium text-foreground/80 truncate">{d.name}</span>
              <span suppressHydrationWarning>{rows[0].online ? 'connected' : rows[0].lastSeenAt ? <Ago iso={rows[0].lastSeenAt} prefix="last seen " /> : 'not connected yet'}</span>
            </div>
            {rows.map(f => (
              <div key={f.key} className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-folder={f.name}>
                <FolderGit2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className={`text-[15px] md:text-sm truncate ${f.missing ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{f.name}</div>
                  <div className="text-[13px] md:text-xs text-muted-foreground truncate">
                    {f.branch ? `branch ${f.branch}` : 'no branch'}
                    {f.missing ? ' · not found in its last scan' : f.online ? '' : ' · computer offline'}
                  </div>
                </div>
                <button type="button" className={iconBtn} disabled={pending} onClick={() => setUnlinking(f)} aria-label={`Unlink ${f.name}`} title="Unlink">
                  <Unlink className="w-4 h-4" /> Unlink
                </button>
              </div>
            ))}
          </div>
        ))}
        {folders.length === 0 && <p className="px-4 md:px-3 py-3 text-sm md:text-xs text-muted-foreground">No folder linked yet. Link one so Claude can open sessions for this project on your computer.</p>}
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
        {turbo && <TurboLines turbo={turbo} />}
        <button type="button" className="w-full flex items-center gap-2 px-4 md:px-3 min-h-12 md:min-h-10 text-sm text-muted-foreground hover:bg-muted/40 active:bg-muted/60" onClick={() => setAdding(true)} data-link-folder>
          <Plus className="w-4 h-4" /> Link folder
        </button>
      </div>
      {adding && <AddFolderSheet projectId={projectId} devices={devices} onClose={() => setAdding(false)} />}
      {unlinking && (
        <ConfirmSheet
          title="Unlink folder"
          message={
            <>
              Unlink &quot;{unlinking.name}&quot; on {unlinking.deviceName} from this project? Claude can no longer start sessions in it from here. Nothing on the computer changes, and you can link it again any time.
            </>
          }
          verb="Unlink"
          danger
          pending={pending}
          onConfirm={() =>
            start(async () => {
              const r = await unlinkFolderAction(projectId, unlinking.key);
              if (!r.ok) return void toast.error(r.error ?? 'Failed');
              toast(`Unlinked ${unlinking.name}`);
              setUnlinking(null);
            })
          }
          onClose={() => setUnlinking(null)}
        />
      )}
    </>
  );
}

/** Turbo mode (lib/data/turbo.ts): per computer where the repo is not yet, what Claude will do when you start. */
function TurboLines({ turbo }: { turbo: TurboInfo }) {
  if (!turbo.repo) {
    return turbo.devices.length ? (
      <p className="px-4 md:px-3 py-2 text-[13px] md:text-xs text-muted-foreground" data-turbo-norepo>
        Add the repo in Info › Code to let your PC clone it.
      </p>
    ) : null;
  }
  const rows = turbo.devices.filter(d => !d.has);
  return (
    <>
      {rows.map(d => (
        <p key={d.id} className="px-4 md:px-3 py-2 text-[13px] md:text-xs text-muted-foreground" data-turbo-device={d.name} data-turbo-state={d.clone}>
          {d.clone === 'ready'
            ? `Not on ${d.name} yet. Claude will clone it into ${d.destination} when you start.`
            : d.clone === 'off'
              ? `Not on ${d.name} yet. Cloning is turned off on that PC.`
              : `Not on ${d.name} yet. Its worker is older and cannot clone; update it under Claude › Setup.`}
        </p>
      ))}
    </>
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
    <Sheet title="Link a folder" onClose={onClose}>
      <div className="space-y-3 pt-1 pb-2">
        {devices.length > 1 && (
          <Select
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
          </Select>
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
