'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { idleFor } from '@/components/idle';

// The three pages people jump between (every warmed page is a server render). Kept warm so the first tap after sitting on a page is instant.
const ROUTES = ['/today', '/tasks', '/projects'];
// Prefetched pages live 5 minutes (staleTimes.static), so they are fetched again at most this often.
// Every fetch is a billed request: a refresh or one of our writes drops the cached copies, but they are not
// fetched again until WARM_MS has passed (a tap in between waits on the server once).
const WARM_MS = 5 * 60_000;
const CHECK_MS = 30_000;
// Nobody using the tab this long: stop warming (an open, untouched tab costs nothing).
const IDLE_MS = 10 * 60_000;
// Back after this long away: refresh what is on screen (Claude may have changed things).
const AWAY_MS = 60_000;
// Module level: survives page changes (the effect restarts on each one).
let warmedAt = 0;

/** While the app is open, visible and in use, keeps the main pages prefetched in the router cache. */
export function Preloader() {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    let stopped = false;
    const warm = (force = false) => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (!force && (Date.now() - warmedAt < WARM_MS || idleFor() > IDLE_MS)) return;
      warmedAt = Date.now();
      for (const r of ROUTES) if (r !== path) router.prefetch(r, { kind: 'full' } as Parameters<typeof router.prefetch>[1]);
    };
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const first = idle(() => warm(), { timeout: 3000 });
    const tick = window.setInterval(() => warm(), CHECK_MS);
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) router.refresh();
      warm();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      (window.cancelIdleCallback ?? window.clearTimeout)(first as number);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [router, path]);
  return null;
}
