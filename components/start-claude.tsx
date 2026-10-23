'use client';

import { PrivateBadge } from '@/components/private-badge';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from '@/components/intent-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ChevronLeft, FolderGit2, Play, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/components/app-context';
import { usePhone } from '@/components/mobile/use-phone';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import type { StartProject } from '@/lib/data/claude-overview';
import type { FolderView } from '@/lib/data/launcher';
import { cn } from '@/lib/utils';
import { linkAndStartAction, searchFoldersAction, startOptionsAction, startProjectsAction, startSessionAction } from '@/app/(app)/projects/[id]/launcher-actions';

// Start Claude (docs/ux-audit/proposal.md §5.5): one flow for every entry point. The URL says what is open:
//   ?start=1          step 1, pick a project
//   ?start=<project>  step 2, confirm folder + first message
// Opening is a normal navigation (system Back closes it); closing and switching steps only rewrite
// the URL in place (router.replace), so they never leave extra history entries.

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring';
const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';
const folderLabel = (f: FolderView) => `${f.name}${f.branch ? ` (${f.branch})` : ''}`;

export function StartClaude() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const sp = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const start = sp.get('start');
  const setParam = (value: string | null) => {
    const u = new URLSearchParams(window.location.search);
    if (value === null) u.delete('start');
    else u.set('start', value);
    const qs = u.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  // Desktop key S: only when not typing and no dialog or sheet is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key !== 's' && e.key !== 'S') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing || document.querySelector('[role="dialog"], [data-sheet]') || !window.matchMedia('(min-width: 768px)').matches) return;
      e.preventDefault();
      const u = new URL(window.location.href);
      u.searchParams.set('start', '1');
      router.push(`${pathname}${u.search}`);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, pathname]);

  if (!start) return null;
  const close = () => setParam(null);
  return start === '1' ? <PickProject onClose={close} onPick={id => setParam(id)} /> : <Confirm key={start} projectId={start} onClose={close} onBack={() => setParam('1')} />;
}

// ── Step 1: pick a project ──────────────────────────────────────────────────

function PickProject({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const phone = usePhone();
  const [projects, setProjects] = useState<StartProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    startProjectsAction().then(r => {
      if (!alive) return;
      if (r.ok) setProjects(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const text = q.trim().toLowerCase();
  const { recent, all, results } = useMemo(() => {
    const list = projects ?? [];
    const match = (p: StartProject) => !text || p.name.toLowerCase().includes(text) || (p.client ?? '').toLowerCase().includes(text);
    const rec = list
      .filter(p => p.folders > 0)
      .sort((a, b) => (b.lastStartedAt ?? '').localeCompare(a.lastStartedAt ?? ''))
      .slice(0, 5);
    const recIds = new Set(rec.map(p => p.id));
    return { recent: rec, all: list.filter(p => !recIds.has(p.id)), results: list.filter(match) };
  }, [projects, text]);

  const row = (p: StartProject) => (
    <li key={p.id}>
      <button type="button" onClick={() => onPick(p.id)} data-start-project={p.id} className="w-full text-left flex items-center gap-2 px-3 min-h-12 md:min-h-10 hover:bg-muted/50 active:bg-muted/60">
        <span className="flex-1 min-w-0">
          <span className="block text-[16px] md:text-sm truncate">{p.name}{p.private && <PrivateBadge compact className="ml-1.5" />}</span>
          {p.client && <span className="block text-[13px] md:text-xs text-muted-foreground truncate">{p.client}</span>}
        </span>
        {p.folders === 0 && (
          <span className="text-[12px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0 inline-flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> needs a folder
          </span>
        )}
      </button>
    </li>
  );
  const group = (title: string, list: StartProject[]) =>
    list.length > 0 && (
      <div className="space-y-1">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <ul className="rounded-xl border border-border divide-y divide-border/60 overflow-hidden">{list.map(row)}</ul>
      </div>
    );

  return (
    <ResponsiveSheet title="Start Claude" onClose={onClose}>
      <div className="space-y-3 pt-1 pb-2" data-start-step="project">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            className={cn(field, 'pl-9')}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && results[0] && onPick(results[0].id)}
            placeholder="Search projects"
            aria-label="Search projects"
            autoFocus={!phone}
            enterKeyHint="go"
          />
        </div>
        <div className="max-h-[55dvh] overflow-y-auto space-y-3">
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : !projects ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : text ? (
            results.length ? group('Results', results) : <p className="text-sm text-muted-foreground">No project matches.</p>
          ) : (
            <>
              {group('Recent', recent)}
              {group('All', all)}
              {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects yet.</p>}
            </>
          )}
        </div>
      </div>
    </ResponsiveSheet>
  );
}

// ── Step 2: confirm folder and first message ────────────────────────────────

type Options = { folders: FolderView[]; suggestions: FolderView[]; devices: { id: string; name: string }[] };

function Confirm({ projectId, onClose, onBack }: { projectId: string; onClose: () => void; onBack: () => void }) {
  const { projectName } = useApp();
  const name = projectName(projectId) ?? projectId;
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState('');
  const [pick, setPick] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    startOptionsAction(projectId).then(r => {
      if (!alive) return;
      if (!r.ok) return void setError(r.error);
      setOpts(r.data);
      // Default computer: one that has a linked folder (online first), else one with a suggestion, else the first.
      const withLinked = r.data.folders.sort((a, b) => Number(b.online) - Number(a.online))[0]?.deviceId;
      setDevice(withLinked ?? r.data.suggestions[0]?.deviceId ?? r.data.devices[0]?.id ?? '');
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const linked = opts?.folders.filter(f => f.deviceId === device) ?? [];
  const suggested = opts?.suggestions.filter(f => f.deviceId === device) ?? [];
  const mode: 'linked' | 'suggest' | 'search' = linked.length ? 'linked' : suggested.length ? 'suggest' : 'search';
  const list = mode === 'linked' ? linked : suggested;
  const chosen = list.find(f => f.key === pick) ?? list[0];
  const deviceName = opts?.devices.find(d => d.id === device)?.name ?? '';

  const go = async (f: FolderView, link: boolean) => {
    setBusy(true);
    try {
      const r = link ? await linkAndStartAction(projectId, f.key, prompt) : await startSessionAction(projectId, f.key, prompt);
      if (!r.ok) return void toast.error(r.error);
      toast(`Starting ${name} on ${f.deviceName}. It appears in the Claude app in a few seconds.`);
      onClose();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveSheet title={`Start ${name}`} onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2" data-start-step="confirm" data-start-mode={opts ? mode : 'loading'}>
        <button type="button" onClick={onBack} className="-ml-2 h-11 md:h-8 px-2 inline-flex items-center gap-0.5 rounded-lg text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Projects
        </button>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !opts ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : opts.devices.length === 0 ? (
          <p className="text-[15px] md:text-sm text-muted-foreground">
            Add a computer first, under{' '}
            <Link href="/claude?tab=setup" onClick={onClose} className="underline">
              Claude › Setup
            </Link>
            .
          </p>
        ) : (
          <>
            {opts.devices.length > 1 && (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Computer</span>
                <select className={field} value={device} onChange={e => setDevice(e.target.value)} aria-label="Computer">
                  {opts.devices.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {mode !== 'search' && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{mode === 'linked' ? 'Folder' : 'Same repo, not linked yet'}</span>
                {list.length === 1 && mode === 'linked' ? (
                  <p className="text-[16px] md:text-sm" data-folder-one>
                    {folderLabel(list[0])} <span className="text-muted-foreground">on {list[0].deviceName}{list[0].online ? '' : ' · offline'}</span>
                  </p>
                ) : (
                  <div className="space-y-1.5" role="radiogroup" aria-label="Folder">
                    {list.map(x => (
                      <label key={x.key} className="flex items-center gap-3 min-h-12 md:min-h-10 px-3 rounded-xl border border-border has-[:checked]:border-foreground cursor-pointer">
                        <input type="radio" name="start-folder" checked={chosen?.key === x.key} onChange={() => setPick(x.key)} className="w-4 h-4" />
                        <span className="flex-1 min-w-0">
                          <span className="block text-[16px] md:text-sm truncate">{folderLabel(x)}</span>
                          <span className="block text-[13px] md:text-xs text-muted-foreground">
                            {x.deviceName}
                            {x.online ? '' : ' · offline'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            {mode === 'search' && <FolderSearch projectId={projectId} deviceId={device} deviceName={deviceName} busy={busy} onPick={f => go(f, true)} />}

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
            {mode !== 'search' && (
              <button type="button" className={`${btn} w-full bg-foreground text-background`} disabled={busy || !chosen} onClick={() => chosen && go(chosen, mode === 'suggest')} data-start-go>
                <Play className="w-4 h-4" /> {mode === 'suggest' ? 'Link and start' : 'Start'}
              </button>
            )}
          </>
        )}
      </div>
    </ResponsiveSheet>
  );
}

/** Nothing linked: search the computer's folders; picking one links it to the project and starts. */
function FolderSearch({ projectId, deviceId, deviceName, busy, onPick }: { projectId: string; deviceId: string; deviceName: string; busy: boolean; onPick: (f: FolderView) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<FolderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => {
        searchFoldersAction(deviceId, q).then(r => {
          if (!alive) return;
          if (r.ok) {
            setList(r.data);
            setError(null);
          } else setError(r.error);
        });
      },
      q ? 200 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [deviceId, q]);

  return (
    <div className="space-y-2" data-folder-search>
      <p className="text-[15px] md:text-sm text-foreground">
        No folder linked to this project yet. Pick one on <span className="font-medium">{deviceName}</span>; it is linked and started.
      </p>
      <input className={field} value={q} onChange={e => setQ(e.target.value)} placeholder="Search folder names" aria-label="Search folder names" />
      <div className="max-h-[30dvh] overflow-y-auto rounded-xl border border-border divide-y divide-border/60">
        {error ? (
          <p className="px-3 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !list ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : list.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">No folders match. Is the worker running and is the folder under one of its roots?</p>
        ) : (
          list.map(f => {
            const other = !!f.projectId && f.projectId !== projectId;
            return (
              <button
                key={f.key}
                type="button"
                data-search-folder={f.name}
                className="w-full text-left flex items-center gap-2 px-3 min-h-12 hover:bg-muted/40 active:bg-muted/60 disabled:opacity-50"
                disabled={busy || other}
                onClick={() => onPick(f)}
              >
                <FolderGit2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[16px] md:text-sm truncate">{folderLabel(f)}</span>
                  {(f.remote || other) && <span className="block text-[12px] text-muted-foreground truncate">{other ? 'linked to another project' : f.remote}</span>}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
