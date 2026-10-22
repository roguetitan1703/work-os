'use client';

// Push in the browser (docs/multi-user.md "As built: phase 5 push"): one Server-Sent Events stream per tab
// (/api/stream), open only while something on the page listens (subscribe) and the tab is in view. The server sends
// "refresh <topic>" hints; listeners fetch the page again the usual way (router.refresh()).
//
// - Reconnects with backoff (1 s doubling to 60 s, jittered). While it is down, isUp() is false and listeners fall
//   back to their slow poll.
// - A tab out of view for a minute closes its stream (browsers allow ~6 connections per site over HTTP/1.1, and a
//   hidden tab needs none); hints that arrive while it is hidden wait until it is back in view.
// - After a gap (stream lost or closed while hidden) listeners get one hint for everything ('*'): something may have
//   changed meanwhile.

export type Hint = { t: string; s?: 1 };
type Listener = (h: Hint) => void;

const HIDDEN_CLOSE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const GAP_MS = 3_000;
const STOP_MS = 5_000;

const listeners = new Set<Listener>();
let es: EventSource | null = null;
let up = false;
let attempt = 0;
let lostAt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let hiddenClose: ReturnType<typeof setTimeout> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let held: Map<string, Hint> | null = null;
let wired = false;

const visible = () => document.visibilityState === 'visible';

function emit(h: Hint) {
  if (!visible()) {
    (held ??= new Map()).set(h.t, h);
    return;
  }
  for (const f of [...listeners]) f(h);
}

function open() {
  clearTimeout(retry);
  retry = undefined;
  if (es || !listeners.size || !visible()) return;
  const s = new EventSource('/api/stream');
  es = s;
  s.addEventListener('hello', () => {
    attempt = 0;
    up = true;
    const missed = lostAt > 0 && Date.now() - lostAt > GAP_MS;
    lostAt = 0;
    if (missed) emit({ t: '*' });
  });
  s.addEventListener('hint', e => {
    try {
      const h = JSON.parse((e as MessageEvent<string>).data) as Hint;
      if (h && typeof h.t === 'string') emit(h);
    } catch {
      // not ours
    }
  });
  // 'ttl': the server ends every stream after a while so the check runs again; come straight back.
  s.addEventListener('bye', e => drop((e as MessageEvent<string>).data.includes('"ttl"') ? 0 : undefined));
  s.onerror = () => drop();
}

function close() {
  if (!es) return;
  es.close();
  es = null;
  if (up) lostAt = Date.now();
  up = false;
}

function drop(delay?: number) {
  close();
  if (!listeners.size) return;
  const d = delay ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++) * (0.8 + Math.random() * 0.4);
  clearTimeout(retry);
  retry = setTimeout(open, d);
}

function onVisibility() {
  if (visible()) {
    clearTimeout(hiddenClose);
    hiddenClose = undefined;
    const h = held;
    held = null;
    if (h) for (const x of h.values()) emit(x);
    if (!es && !retry) open();
  } else if (!hiddenClose) {
    hiddenClose = setTimeout(() => {
      hiddenClose = undefined;
      if (!visible()) close();
    }, HIDDEN_CLOSE_MS);
  }
}

/** Listen for hints; opens the stream on first use and closes it a few seconds after the last listener leaves. */
export function subscribe(f: Listener): () => void {
  listeners.add(f);
  clearTimeout(stopTimer);
  if (!wired) {
    wired = true;
    document.addEventListener('visibilitychange', onVisibility);
  }
  open();
  return () => {
    listeners.delete(f);
    if (listeners.size) return;
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (listeners.size) return;
      clearTimeout(retry);
      retry = undefined;
      close();
      lostAt = 0;
    }, STOP_MS);
  };
}

/** Is the stream connected (hints arrive)? When not, listeners poll. */
export const isUp = (): boolean => up;
