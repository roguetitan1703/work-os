'use client';

import { useEffect } from 'react';

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
