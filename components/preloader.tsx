'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// The pages people jump between. Kept warm so the first tap after sitting on a page is instant.
const ROUTES = ['/today', '/tasks', '/notes', '/menu', '/projects', '/notifications', '/settings', '/connect', '/history'];
// Prefetched pages live 5 minutes (staleTimes.static). Asking for a page that is still cached costs
// nothing, so check often: an expired page is fetched again within CHECK_MS (a tap in that short gap waits on the server).
// (Not router.refresh(): pages fetched after a refresh were measured to expire within a minute.)
const CHECK_MS = 4_000;
// Back after this long away: refresh what is on screen (Claude may have changed things).
const AWAY_MS = 60_000;

/** While the app is open and visible, keeps the main pages fully prefetched in the router cache. */
export function Preloader() {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    let stopped = false;
    // onInvalidate: the router dropped this page's copy (a refresh, or one of our writes), so fetch it again.
    const load = (r: string) => {
      if (stopped || document.visibilityState !== 'visible') return;
      router.prefetch(r, { kind: 'full', onInvalidate: () => window.setTimeout(() => load(r), 1000) } as Parameters<typeof router.prefetch>[1]);
    };
    const warm = () => {
      for (const r of ROUTES) if (r !== path) load(r);
    };
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const first = idle(warm, { timeout: 3000 });
    const tick = window.setInterval(warm, CHECK_MS);
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
