'use client';

import { useEffect } from 'react';

// In-app page stack for the "Back goes where you came from, else the parent" rule. Lives in module
// state, so a fresh page load (a deep link, a reload) starts with just the landing page and Back
// falls back to the parent. Kept by wrapping the History API, because the Next router calls
// pushState / replaceState itself and the order against React effects is not reliable.
const stack: string[] = [];
let installed = false;

const pathOf = (url?: string | URL | null) => (url ? new URL(String(url), window.location.href).pathname : window.location.pathname);

function install() {
  if (installed) return;
  installed = true;
  stack.push(window.location.pathname);
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  window.history.pushState = (data, unused, url) => {
    push(data, unused, url);
    const p = pathOf(url);
    if (stack[stack.length - 1] !== p) stack.push(p);
  };
  window.history.replaceState = (data, unused, url) => {
    replace(data, unused, url);
    stack[stack.length - 1] = pathOf(url);
  };
  window.addEventListener('popstate', () => {
    const p = window.location.pathname;
    const i = stack.lastIndexOf(p);
    if (i >= 0) stack.length = i + 1;
    else stack.push(p);
  });
}

/** True when there is an earlier in-app page to go back to. */
export function hasInAppPrev(): boolean {
  return stack.length > 1;
}

/** Mounted once in the app layout: starts recording in-app navigation. */
export function NavTracker() {
  useEffect(install, []);
  return null;
}
