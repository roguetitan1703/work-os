'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { startDelpatOsLinkAction, unlinkDelpatOsAction } from './delpat-os-actions';

const btn = 'inline-flex items-center justify-center h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';

/** The result of coming back from Delpat OS: a fixed word set by /api/delpat-os/callback (never text from the address). */
export function DelpatOsNotice({ linked }: { linked: boolean }) {
  const flag = useSearchParams().get('delpat');
  if (flag === 'linked' && linked) return <p className="text-[13px] text-foreground" data-delpat-notice>Delpat OS is linked.</p>;
  if (flag === 'error' && !linked) return <p className="text-[13px] text-destructive" data-delpat-notice>Could not link Delpat OS. Sign in to Work OS, then press Link again.</p>;
  return null;
}

/** Link (goes to Delpat OS to allow) or Unlink, as the Connections table's button. */
export function DelpatOsButton({ linked }: { linked: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return linked ? (
    <button
      type="button"
      className={cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60')}
      disabled={pending}
      data-delpat-unlink
      data-connection-action="delpat-os"
      onClick={() =>
        start(async () => {
          const r = await unlinkDelpatOsAction();
          if (!r.ok) return void toast.error(r.error);
          router.replace('/settings?section=connections');
          router.refresh();
        })
      }
    >
      Unlink
    </button>
  ) : (
    <button
      type="button"
      className={cn(btn, 'bg-foreground text-background hover:bg-foreground/90')}
      disabled={pending}
      data-delpat-link
      data-connection-action="delpat-os"
      onClick={() =>
        start(async () => {
          const r = await startDelpatOsLinkAction();
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.data.url);
        })
      }
    >
      Link
    </button>
  );
}
