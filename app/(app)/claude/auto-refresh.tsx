'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Re-reads the server data when the tab regains focus and every ~10 s while it is visible. */
export function AutoRefresh({ every = 10_000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const go = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2_000) return;
      last = Date.now();
      router.refresh();
    };
    const t = setInterval(go, every);
    document.addEventListener('visibilitychange', go);
    window.addEventListener('focus', go);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', go);
      window.removeEventListener('focus', go);
    };
  }, [router, every]);
  return null;
}
