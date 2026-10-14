'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// The pages people jump between. Kept warm so the first tap after sitting on a page is instant.
const ROUTES = ['/today', '/board', '/notes', '/more', '/projects', '/notifications', '/settings', '/connect', '/history'];
// Prefetched pages live 5 minutes (staleTimes.static). Just before that, refresh: this drops the
// cached copies (and updates the page on screen) so the next round fetches fresh ones.
const REFRESH_MS = 4 * 60_000;
// Back after this long away: refresh what is on screen (Claude may have changed things).
const AWAY_MS = 60_000;

/** While the app is open and visible, keeps the main pages fully prefetched in the router cache. */
export function Preloader() {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const warm = () => {
      if (document.visibilityState !== 'visible') return;
      for (const r of ROUTES) if (r !== path) router.prefetch(r, { kind: 'full' } as Parameters<typeof router.prefetch>[1]);
    };
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const first = idle(warm, { timeout: 3000 });
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      warm();
    }, REFRESH_MS);
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) router.refresh();
      warm();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      (window.cancelIdleCallback ?? window.clearTimeout)(first as number);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [router, path]);
  return null;
}
