'use client';

import { useEffect } from 'react';
import { useTheme } from 'next-themes';

/**
 * Registers the service worker (production only) so the app can be installed and opens
 * offline, and enables :active styles on iOS (Safari only applies them once a touch
 * listener exists), which is what gives taps visible feedback.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    const noop = () => {};
    document.addEventListener('touchstart', noop, { passive: true });
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => document.removeEventListener('touchstart', noop);
  }, []);
  return null;
}

/** Keeps the phone's status-bar colour in step with the app's theme (which can differ from the OS setting). */
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (!resolvedTheme) return;
    const color = getComputedStyle(document.body).backgroundColor || (resolvedTheme === 'dark' ? '#0a0a0a' : '#ffffff');
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length) metas.forEach(m => m.setAttribute('content', color));
    else {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = color;
      document.head.appendChild(m);
    }
  }, [resolvedTheme]);
  return null;
}
