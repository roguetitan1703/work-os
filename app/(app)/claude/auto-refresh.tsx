'use client';

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { idleFor } from '@/components/idle';

// A page left open but untouched stops refreshing (each refresh is a billed request); any input resumes it.
const IDLE_MS = 5 * 60_000;

// After a write (a server action that revalidates), the action's response carries the new page and the router shows it
// in a transition. That transition sometimes suspends on the last bit of the response stream and is not retried when
// the stream ends (Next 16.2 / its React canary), so the old page stays until some other update. Any React update
// retries it, so while a write is landing, AutoRefresh re-renders itself (no request) until the new page is on screen.
// A refresh started meanwhile is one more transition in the same race, and the write already brings the fresh page,
// so the auto-refresh also holds off during a write and for 2 s after it.
const POKE_MS = 150;
const LAND_MS = 5_000;
let writes = 0;
let quietUntil = 0;
let shown = 0; // stamp of the page on screen
let landing: { stamp: number; until: number } | null = null;
let poke: (() => void) | null = null;

/** Runs a page write (a server action that revalidates) and makes sure its new page reaches the screen. */
export async function write<T>(fn: () => Promise<T>): Promise<T> {
  writes++;
  let ok = false;
  try {
    const r = await fn();
    ok = (r as { ok?: boolean } | null)?.ok !== false;
    return r;
  } finally {
    writes--;
    quietUntil = Date.now() + 2_000;
    if (ok) {
      landing = { stamp: shown, until: Date.now() + LAND_MS };
      poke?.();
    }
  }
}

/**
 * Re-reads the server data when the tab regains focus and every ~30 s while it is visible and in use.
 * stamp: changes with every server render of the page (tells when a write's new page is on screen).
 */
export function AutoRefresh({ every = 30_000, stamp }: { every?: number; stamp: number }) {
  const router = useRouter();
  const [pokes, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    shown = stamp;
    poke = bump;
    return () => {
      poke = null;
    };
  }, [stamp]);

  // While a write is landing: re-render now and then until the page from the server changes (or give up after 5 s).
  useEffect(() => {
    if (!landing) return;
    if (stamp !== landing.stamp || Date.now() > landing.until) {
      landing = null;
      return;
    }
    const t = setTimeout(bump, POKE_MS);
    return () => clearTimeout(t);
  }, [stamp, pokes]);

  useEffect(() => {
    let last = Date.now();
    const go = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2_000 || writes > 0 || Date.now() < quietUntil) return;
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
