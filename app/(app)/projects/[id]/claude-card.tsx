'use client';

import { Ago } from '@/components/ago';
import { useState } from 'react';
import Link from '@/components/intent-link';
import { useRouter } from 'next/navigation';
import { Square } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { cn } from '@/lib/utils';
import { sessionCan, stateText } from '@/lib/session-state';
import type { SessionView } from '@/lib/data/launcher';
import { ghost } from '@/app/(app)/claude/ui';
import { stopSessionAction } from './launcher-actions';

type Props = {
  projectId: string;
  tabHref: string;
  running: SessionView[];
  hasComputers: boolean;
};

/** Overview card: the running sessions (one line each). Compact on purpose. */
export function ClaudeCard({ projectId, tabHref, running, hasComputers }: Props) {
  const router = useRouter();
  const [stopping, setStopping] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const summary = running.length ? `${running.length} running` : '';

  const stop = async (s: SessionView) => {
    setBusy(true);
    try {
      const r = await stopSessionAction(projectId, s.id);
      if (!r.ok) return void toast.error(r.error);
      toast('Stopping…');
      setStopping(null);
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden" data-card="claude">
      <header className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9">
        <h2 className="text-[13px] md:text-xs font-semibold uppercase tracking-wider text-muted-foreground">Claude</h2>
        <span className="text-[13px] md:text-xs truncate text-muted-foreground">{summary}</span>
        <Link href={tabHref} replace scroll={false} className="ml-auto h-11 md:h-9 px-1 inline-flex items-center text-[13px] md:text-xs text-muted-foreground hover:text-foreground shrink-0">
          See all ›
        </Link>
      </header>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {running.map(s => {
          const st = stateText(s);
          return (
            <div key={s.id} className="flex items-center gap-2 pl-4 md:pl-3 pr-1 min-h-11 md:min-h-9" data-session={s.id}>
              <span aria-hidden className={cn('w-2 h-2 rounded-full shrink-0', s.state === 'running' ? 'bg-green-500' : 'bg-amber-500')} />
              <div className="flex-1 min-w-0 text-[15px] md:text-sm truncate" suppressHydrationWarning>
                <span className="font-medium">{s.folderName}</span>
                <span className="text-muted-foreground">
                  {' '}· {s.deviceName} · <span className={st.tone}>{st.label}</span> · <Ago iso={s.startedAt} />
                </span>
              </div>
              {sessionCan(s).stop && (
                <button type="button" className={ghost} disabled={busy} onClick={() => setStopping(s)} aria-label={`Stop ${s.folderName} on ${s.deviceName}`}>
                  <Square className="w-4 h-4" /> Stop
                </button>
              )}
            </div>
          );
        })}
        {!running.length && (
          <p className="px-4 md:px-3 min-h-11 md:min-h-9 flex items-center text-[15px] md:text-sm text-muted-foreground">
            {hasComputers ? 'Nothing running.' : 'No computer added yet.'}
          </p>
        )}
      </div>
      {stopping && (
        <ConfirmSheet
          title="Stop session"
          message={<>Stop the session in {stopping.folderName} on {stopping.deviceName}? Its terminal closes; you can resume it later.</>}
          verb="Stop"
          danger
          pending={busy}
          onConfirm={() => stop(stopping)}
          onClose={() => setStopping(null)}
        />
      )}
    </section>
  );
}
