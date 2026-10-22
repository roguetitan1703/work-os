'use client';

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { idleFor } from '@/components/idle';
import { isUp, subscribe, type Hint } from '@/components/live';

// Push (components/live.ts): the server says when something this page shows has changed, and the page refreshes
// then. Only while the stream is down does it poll as before: every ~30 s while the tab is visible and in use, and
// on coming back to the tab. A page left open but untouched stops polling (each refresh is a request); any input
// resumes it.
const IDLE_MS = 5 * 60_000;
/** Hints close together are one refresh. */
const HINT_DELAY_MS = 400;

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
 * Re-reads the server data when the server pushes a change to one of `topics` (components/live.ts), and, while the
 * push stream is down, when the tab regains focus and every ~30 s while it is visible and in use.
 * stamp: changes with every server render of the page (tells when a write's new page is on screen).
 */
// 'claude' covers Claude items, computers, sessions and tasks given to Claude (lib/scope.ts sends it for a task write
// that touches the mark); other task edits do not refresh this page.
export function AutoRefresh({ every = 30_000, stamp, topics = ['claude'] }: { every?: number; stamp: number; topics?: string[] }) {
  const router = useRouter();
  const [pokes, bump] = useReducer((n: number) => n + 1, 0);
  const topicKey = topics.join(',');

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
    let later: ReturnType<typeof setTimeout> | undefined;
    // poll: drop it when a write is in flight or a refresh just ran (the old behaviour). A pushed change is never
    // dropped: it waits until the write has landed (the write's own page may predate it).
    const go = (pushed = false) => {
      if (document.visibilityState !== 'visible') return;
      const wait = Math.max(last + 2_000, quietUntil) - Date.now();
      if (writes > 0 || wait > 0) {
        if (pushed && !later) later = setTimeout(() => ((later = undefined), go(true)), Math.max(wait, POKE_MS));
        return;
      }
      last = Date.now();
      router.refresh();
      // A pushed refresh can stall the same way a write's page can (see write()): re-render until it is on screen.
      if (pushed) {
        landing = { stamp: shown, until: Date.now() + LAND_MS };
        poke?.();
      }
    };
    const wanted = new Set(topicKey.split(','));
    const onHint = (h: Hint) => {
      if (h.t !== '*' && !wanted.has(h.t)) return;
      // The person's own change while this tab is writing: the write's response already carries the new page.
      if (h.s && (writes > 0 || Date.now() < quietUntil)) return;
      if (!later) later = setTimeout(() => ((later = undefined), go(true)), HINT_DELAY_MS);
    };
    const unsubscribe = subscribe(onHint);
    const tick = () => { if (!isUp() && idleFor() < IDLE_MS) go(); };
    const onFocus = () => { if (!isUp()) go(); };
    const t = setInterval(tick, every);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      clearTimeout(later);
      clearInterval(t);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [router, every, topicKey]);
  return null;
}
