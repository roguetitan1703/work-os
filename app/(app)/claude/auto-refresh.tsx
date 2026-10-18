'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { idleFor } from '@/components/idle';

// A page left open but untouched stops refreshing (each refresh is a billed request); any input resumes it.
const IDLE_MS = 5 * 60_000;

/** Re-reads the server data when the tab regains focus and every ~30 s while it is visible and in use. */
export function AutoRefresh({ every = 30_000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const go = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2_000) return;
      last = Date.now();
      router.refresh();
    };
    const tick = () => { if (idleFor() < IDLE_MS) go(); };
    const t = setInterval(tick, every);
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
