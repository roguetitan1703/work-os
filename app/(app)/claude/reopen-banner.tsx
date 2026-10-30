'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ReopenPrompt } from '@/lib/data/launcher';
import { dismissReopenAction, reopenAllAction } from '../projects/[id]/launcher-actions';
import { write } from './auto-refresh';
import { btnOutline } from './ui';
import { trackJob } from './job-toast';

const banner = 'rounded-xl bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-1.5 text-[15px] md:text-sm';
const where = (o: string) => (o === 'vscode' ? 'VS Code' : 'a terminal');

/** "N sessions were open before your PC restarted": nothing is reopened until Reopen all is tapped. */
export function ReopenBanner({ prompts, onlyDevices }: { prompts: ReopenPrompt[]; onlyDevices?: string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shown = prompts.filter(p => !hidden.has(p.deviceId) && (!onlyDevices || onlyDevices.includes(p.deviceId)));
  if (!shown.length) return null;
  const hide = (id: string) => setHidden(h => new Set(h).add(id));
  const reopen = async (p: ReopenPrompt) => {
    setBusy(p.deviceId);
    try {
      const r = await write(() => reopenAllAction(p.deviceId));
      if (!r.ok) return void toast.error(r.error);
      hide(p.deviceId);
      void trackJob(r.data, `Reopening ${p.items.length} ${p.items.length === 1 ? 'session' : 'sessions'}…`, 'Reopened');
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (p: ReopenPrompt) => {
    setBusy(p.deviceId);
    try {
      const r = await write(() => dismissReopenAction(p.deviceId));
      if (!r.ok) return void toast.error(r.error);
      hide(p.deviceId);
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2" data-reopen-banners>
      {shown.map(p => {
        const n = p.items.length;
        return (
          <div key={p.deviceId} className={cn(banner, 'space-y-1')} data-reopen-banner={p.deviceId}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1" data-reopen-text>
                {n} {n === 1 ? 'session was' : 'sessions were'} open before {p.deviceName} restarted.
              </span>
              <button type="button" className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} disabled={busy === p.deviceId || !p.online} title={p.online ? undefined : 'That PC is offline'} onClick={() => reopen(p)} data-reopen-all>
                Reopen all
              </button>
              <button type="button" className={btnOutline} disabled={busy === p.deviceId} onClick={() => dismiss(p)} data-reopen-dismiss>
                Dismiss
              </button>
            </div>
            <ul className="text-[13px] md:text-xs text-amber-800/80 dark:text-amber-300/80">
              {p.items.slice(0, 8).map(i => (
                <li key={i.sessionId} className="truncate">
                  {i.title} · {i.folder} · in {where(i.origin)}
                </li>
              ))}
              {n > 8 && <li>and {n - 8} more</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
