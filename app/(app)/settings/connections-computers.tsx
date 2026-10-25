import Link from '@/components/intent-link';
import { ChevronRight, Laptop } from 'lucide-react';
import { Ago } from '@/components/ago';
import { listDevices } from '@/lib/devices';
import type { Caller } from '@/lib/caller';
import { Dot } from './ui';

const ONLINE_MS = 2 * 60_000;
const heardRecently = (iso: string | null) => !!iso && Date.now() - Date.parse(iso) < ONLINE_MS;

/** The person's own computers (workers), read-only; Add, Replace key and Revoke live in Claude › Setup › Computers. */
export async function ConnectionsComputers({ caller }: { caller: Caller }) {
  const devices = await listDevices(caller);
  return (
    <div data-connection="computers" className="rounded-2xl bg-card border border-border/70 overflow-hidden min-w-0">
      <div className="px-4 pt-3 pb-1 flex items-center gap-3">
        <Laptop className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="text-[16px] font-medium text-foreground">Computers</div>
      </div>
      {devices.length === 0 ? (
        <p className="px-4 pb-3 pl-12 text-[13px] text-muted-foreground">No computer connected yet.</p>
      ) : (
        <ul className="px-4 pb-1 pl-12 space-y-1">
          {devices.map(d => {
            const on = heardRecently(d.lastSeenAt);
            return (
              <li key={d.id} data-computer={d.name} className="flex items-center gap-2 text-[13px] text-foreground/85 min-w-0">
                <Dot level={on ? 'ok' : 'off'} />
                <span className="truncate">{d.name}</span>
                <span className="text-muted-foreground shrink-0" suppressHydrationWarning>
                  {on ? 'connected' : d.lastSeenAt ? <Ago iso={d.lastSeenAt} prefix="last seen " /> : 'not connected yet'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/claude?tab=setup" className="flex items-center justify-between gap-2 px-4 py-3 pl-12 min-h-11 text-[13px] text-foreground underline-offset-2 hover:underline active:bg-muted/60">
        <span>Manage computers: add, replace key, remove</span>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      </Link>
    </div>
  );
}
