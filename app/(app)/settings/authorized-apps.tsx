'use client';

import { useState, useTransition } from 'react';
import { Plug, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Ago } from '@/components/ago';
import { ConfirmSheet } from '@/components/responsive-sheet';
import type { AuthorizedApp } from '@/lib/oauth';
import { revokeAppAction } from './apps-actions';

const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Apps you signed in to Work OS with (claude.ai, Claude Code, …): when connected, last used, Revoke. */
export function AuthorizedApps({ initial }: { initial: AuthorizedApp[] }) {
  const [apps, setApps] = useState(initial);
  const [confirm, setConfirm] = useState<AuthorizedApp | null>(null);
  const [pending, start] = useTransition();

  const revoke = (a: AuthorizedApp) =>
    start(async () => {
      const r = await revokeAppAction(a.clientId);
      if (!r.ok) return void toast.error(r.error);
      setApps(r.data);
      setConfirm(null);
      toast(`Revoked "${a.name}"`);
    });

  return (
    <div data-authorized-apps className="space-y-2">
      <div className="rounded-2xl border border-border/70 divide-y divide-border/60 bg-card overflow-hidden">
        {apps.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No app is signed in yet.</p>
        ) : (
          apps.map(a => (
            <div key={a.clientId} data-app={a.clientId} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
              <Plug className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] md:text-sm text-foreground truncate">
                  {a.name} <span className="text-xs text-muted-foreground">· {a.agent === 'claude' ? 'Claude chat' : 'Claude Code limits'}</span>
                </div>
                <div className="text-[13px] md:text-xs text-muted-foreground leading-snug truncate" suppressHydrationWarning>
                  connected {day(a.since)} · {a.lastUsedAt ? <Ago iso={a.lastUsedAt} prefix="last used " /> : 'not used yet'}
                </div>
              </div>
              <button type="button" className={iconBtn} onClick={() => setConfirm(a)} disabled={pending} aria-label={`Revoke ${a.name}`} title="Revoke">
                <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
              </button>
            </div>
          ))
        )}
      </div>
      {confirm && (
        <ConfirmSheet
          title="Revoke app"
          message={`Revoke "${confirm.name}"? It stops working at once. To use it again it has to sign in and ask you to allow it.`}
          verb="Revoke"
          danger
          pending={pending}
          onConfirm={() => revoke(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
