'use client';

import { useSyncExternalStore } from 'react';

const Q = '(max-width: 767px)';

/** True on phone-width viewports (below Tailwind `md`). False during SSR. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    cb => {
      const m = window.matchMedia(Q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(Q).matches,
    () => false,
  );
}
