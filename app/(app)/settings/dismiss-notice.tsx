'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { dismissMigrationNoticeAction } from './security-actions';

export function DismissNotice() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="h-11 px-4 rounded-full text-sm font-semibold border border-border disabled:opacity-50"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await dismissMigrationNoticeAction();
          if (!r.ok) return void toast.error(r.error);
          router.refresh();
        })
      }
    >
      Done, hide this
    </button>
  );
}
