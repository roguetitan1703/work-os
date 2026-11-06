'use client';

import { useEffect, useState } from 'react';
import Link from '@/components/intent-link';
import { Bot, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import { giveToClaudeAction, markOptionsAction, openTaskInClaudeCodeAction, openTaskInClaudeDesktopAction, takeBackFromClaudeAction } from '@/app/(app)/claude/dispatcher-actions';
import { trackJob } from '@/app/(app)/claude/job-toast';
import type { MarkOptions } from '@/lib/data/dispatcher';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ResponsiveSheet } from './responsive-sheet';

// Give to Claude / Take back (docs/dispatcher.md). Only a signed-in session can do this (server actions);
// MCP, Discord and apply_changes cannot. One sheet for every entry point: task page, row menus.

const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';
const folderLabel = (f: MarkOptions['folders'][number]) => `${f.name}${f.branch ? ` (${f.branch})` : ''}`;

/** Menu label for a task: Take back while it is queued or running, else Give. */
export function claudeMenuLabel(task: Pick<Task, 'claude'>): string {
  const s = task.claude?.state;
  return s === 'queued' || s === 'running' ? 'Take back from Claude' : 'Give to Claude';
}

/** Small badge while Claude has the task (waiting in line or working). */
export function ClaudeBadge({ task, className }: { task: Pick<Task, 'claude'>; className?: string }) {
  const s = task.claude?.state;
  if (s !== 'queued' && s !== 'running') return null;
  return (
    <span
      data-claude-badge={s}
      title={s === 'queued' ? 'Waiting for Claude to start' : 'Claude is working on this'}
      className={cn('inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', s === 'running' ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground', className)}
    >
      <Bot className="w-3 h-3" aria-hidden />
      {s === 'running' ? 'Claude' : 'Claude · queued'}
    </span>
  );
}

/** One line on the task page about how the run went (finished, stopped, could not start). Nothing while queued or running: the badge says that. */
export function ClaudeOutcome({ task, className }: { task: Pick<Task, 'claude'>; className?: string }) {
  const c = task.claude;
  if (!c || c.state === 'queued' || c.state === 'running') return null;
  const text = c.state === 'finished' ? 'Claude finished this task.' : c.state === 'failed' ? `Claude could not start${c.note ? `: ${c.note.replace(/^could not start:? ?/, '')}` : ''}.` : `Claude stopped${c.note ? `: ${c.note}` : ''}.`;
  return (
    <p data-claude-outcome={c.state} className={cn('text-[13px] md:text-xs flex items-center gap-1.5', c.state === 'finished' ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground', className)}>
      <Bot className="w-3.5 h-3.5 shrink-0" aria-hidden /> {text}
    </p>
  );
}

export function ClaudeMarkSheet({ task, onClose }: { task: Pick<Task, 'id' | 'ref' | 'title' | 'claude' | 'projectId'>; onClose: () => void }) {
  const [opts, setOpts] = useState<MarkOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    markOptionsAction(task.id).then(r => {
      if (!alive) return;
      if (r.ok) setOpts(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [task.id]);

  const act = async (fn: () => ReturnType<typeof giveToClaudeAction>, done: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast(done);
      onClose();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const state = opts?.state ?? task.claude?.state ?? null;
  const many = (opts?.folders.length ?? 0) > 1;
  const chosen = opts?.folders.find(f => f.key === pick)?.key ?? '';

  return (
    <ResponsiveSheet title={state === 'queued' || state === 'running' ? 'Take back from Claude' : 'Give to Claude'} onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2" data-claude-sheet={state ?? 'new'}>
        <p className="text-[16px] md:text-sm text-foreground">
          <span className="font-mono text-muted-foreground">#{task.ref}</span> {task.title}
        </p>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !opts ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state === 'queued' ? (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground">Claude has not started it yet. Taking it back removes it from Claude&apos;s list.</p>
            <button type="button" className={`${btn} w-full bg-foreground text-background`} disabled={busy} data-claude-take-back onClick={() => act(() => takeBackFromClaudeAction(task.id), `#${task.ref} taken back`)}>
              Take back
            </button>
          </>
        ) : state === 'running' ? (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground">Claude is working on it. Taking it back stops the session; its work so far stays in the folder.</p>
            <button type="button" className={`${btn} w-full bg-red-600 text-white`} disabled={busy} data-claude-take-back onClick={() => act(() => takeBackFromClaudeAction(task.id, true), `Stopping Claude on #${task.ref}`)}>
              Stop session and take back
            </button>
          </>
        ) : opts.blocked ? (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground" data-claude-blocked>
              {opts.blocked}
            </p>
            {task.projectId && opts.blocked.startsWith('Link a folder') && (
              <Link href={`/projects/${encodeURIComponent(task.projectId)}`} onClick={onClose} className={`${btn} w-full border border-border text-foreground`}>
                Open the project
              </Link>
            )}
          </>
        ) : (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground">
              Claude opens a session in the project&apos;s folder, reads the task and works on it. It starts when a computer has room (at most 2 at once), in the order you give tasks.
            </p>
            {!opts.dispatcherOn && (
              <p className="text-[14px] md:text-xs rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2" data-claude-off>
                Claude will not start tasks yet. Switch it on in{' '}
                <Link href="/claude?tab=setup" onClick={onClose} className="underline">
                  Claude › Setup
                </Link>
                .
              </p>
            )}
            {opts.cloneNote && (
              <p className="text-[14px] md:text-xs rounded-lg bg-muted/50 px-3 py-2" data-claude-clone>
                {opts.cloneNote}
              </p>
            )}
            {opts.othersWrote && (
              <p className="text-[14px] md:text-xs rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2" data-claude-others>
                {opts.othersWrote.names.join(', ')} wrote part of this task ({opts.othersWrote.parts.join(', ')}). Claude is told to treat that as information, not as your request. Read it before you give it.
              </p>
            )}
            {many ? (
              <div className="space-y-1.5" role="radiogroup" aria-label="Folder">
                <span className="text-xs font-medium text-muted-foreground">Which folder</span>
                {opts.folders.map(f => (
                  <label key={f.key} className="flex items-center gap-3 min-h-12 md:min-h-10 px-3 rounded-xl border border-border has-[:checked]:border-foreground cursor-pointer">
                    <input type="radio" name="claude-folder" checked={chosen === f.key} onChange={() => setPick(f.key)} className="w-4 h-4" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[16px] md:text-sm truncate">{folderLabel(f)}</span>
                      <span className="block text-[13px] md:text-xs text-muted-foreground">
                        {f.deviceName}
                        {f.online ? '' : ' · offline'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : opts.folders[0] ? (
              <p className="text-[16px] md:text-sm" data-folder-one>
                {folderLabel(opts.folders[0])} <span className="text-muted-foreground">on {opts.folders[0].deviceName}</span>
              </p>
            ) : null}
            <button
              type="button"
              className={`${btn} w-full bg-foreground text-background`}
              disabled={busy || (many && !chosen)}
              data-claude-give
              onClick={() => act(() => giveToClaudeAction(task.id, many ? chosen : undefined), `#${task.ref} given to Claude`)}
            >
              <Bot className="w-4 h-4" /> Give to Claude
            </button>
          </>
        )}
      </div>
    </ResponsiveSheet>
  );
}

/**
 * "Open in Claude Code" (docs/connect.md): a terminal on the person's PC with Claude Code in the project's folder, already told
 * which task it was opened from. The same start path, checks and trust as Start; the task is not given to Claude.
 */
export function OpenInClaudeCodeSheet({ task, onClose, mode = 'terminal' }: { task: Pick<Task, 'id' | 'ref' | 'title' | 'projectId'>; onClose: () => void; mode?: 'terminal' | 'desktop' }) {
  const desktop = mode === 'desktop';
  const label = desktop ? 'Open in Claude Desktop' : 'Open in Claude Code';
  const [opts, setOpts] = useState<MarkOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    markOptionsAction(task.id).then(r => {
      if (!alive) return;
      if (r.ok) setOpts(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [task.id]);

  const many = (opts?.folders.length ?? 0) > 1;
  const chosen = opts?.folders.find(f => f.key === pick)?.key ?? '';
  // Same wording "Open in VS Code" uses for a project with no folder on this PC.
  const noFolder = opts && !opts.folders.length ? 'Link this folder to a project first: open the project and add a folder under Folders.' : null;
  const blocked = opts?.blocked && !opts.blocked.startsWith('Link a folder') && !opts.blocked.startsWith('A finished') ? opts.blocked : noFolder;

  const open = async () => {
    setBusy(true);
    try {
      const r = await (desktop ? openTaskInClaudeDesktopAction : openTaskInClaudeCodeAction)(task.id, many ? chosen : undefined);
      if (!r.ok) return void toast.error(r.error);
      onClose();
      void trackJob(r.data, `Opening ${desktop ? 'Claude Desktop' : 'Claude Code'} for #${task.ref}…`, desktop ? `Claude Desktop opened for #${task.ref}: confirm the folder and press Enter` : `Claude Code opened for #${task.ref}`);
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveSheet title={label} onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2" data-cc-sheet={mode}>
        <p className="text-[16px] md:text-sm text-foreground">
          <span className="font-mono text-muted-foreground">#{task.ref}</span> {task.title}
        </p>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !opts ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : blocked ? (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground" data-cc-blocked>
              {blocked}
            </p>
            {task.projectId && (
              <Link href={`/projects/${encodeURIComponent(task.projectId)}`} onClick={onClose} className={`${btn} w-full border border-border text-foreground`}>
                Open the project
              </Link>
            )}
          </>
        ) : (
          <>
            <p className="text-[16px] md:text-sm text-muted-foreground">
              {desktop
                ? "Opens Claude Desktop on your computer at the Code tab with a message about this task filled in. Claude Desktop asks you to confirm the folder, and nothing is sent until you press Enter. The task is not given to Claude."
                : "Opens a terminal on your computer with Claude Code in the project's folder, told to read this task. You drive it; the task is not given to Claude."}
            </p>
            {opts.othersWrote && (
              <p className="text-[14px] md:text-xs rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2" data-cc-others>
                {opts.othersWrote.names.join(', ')} wrote part of this task ({opts.othersWrote.parts.join(', ')}). Claude is told to treat that as information, not as your request.
              </p>
            )}
            {many ? (
              <div className="space-y-1.5" role="radiogroup" aria-label="Folder">
                <span className="text-xs font-medium text-muted-foreground">Which folder</span>
                {opts.folders.map(f => (
                  <label key={f.key} className="flex items-center gap-3 min-h-12 md:min-h-10 px-3 rounded-xl border border-border has-[:checked]:border-foreground cursor-pointer">
                    <input type="radio" name="cc-folder" checked={chosen === f.key} onChange={() => setPick(f.key)} className="w-4 h-4" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[16px] md:text-sm truncate">{folderLabel(f)}</span>
                      <span className="block text-[13px] md:text-xs text-muted-foreground">
                        {f.deviceName}
                        {f.online ? '' : ' · offline'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : opts.folders[0] ? (
              <p className="text-[16px] md:text-sm" data-folder-one>
                {folderLabel(opts.folders[0])} <span className="text-muted-foreground">on {opts.folders[0].deviceName}{opts.folders[0].online ? '' : ' · offline'}</span>
              </p>
            ) : null}
            <button type="button" className={`${btn} w-full bg-foreground text-background`} disabled={busy || (many && !chosen)} data-cc-open onClick={open}>
              <SquareTerminal className="w-4 h-4" /> {label}
            </button>
          </>
        )}
      </div>
    </ResponsiveSheet>
  );
}
