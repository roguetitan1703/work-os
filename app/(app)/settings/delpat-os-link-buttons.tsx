'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { startDelpatOsLinkAction, unlinkDelpatOsAction } from './delpat-os-actions';

const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold border border-border disabled:opacity-50';

export function DelpatOsLinkButtons({ linked }: { linked: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const flag = useSearchParams().get('delpat'); // set by /api/delpat-os/callback; a fixed word only, never text from the address
  return (
    <>
      {flag === 'linked' && linked && <p className="text-[13px] text-foreground" data-delpat-notice>Delpat OS is linked.</p>}
      {flag === 'error' && !linked && <p className="text-[13px] text-destructive" data-delpat-notice>Could not link Delpat OS. Sign in to Work OS, then press Link again.</p>}
      {linked ? (
        <button
          type="button"
          className={btn}
          disabled={pending}
          data-delpat-unlink
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
          className={btn}
          disabled={pending}
          data-delpat-link
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
      )}
    </>
  );
}
