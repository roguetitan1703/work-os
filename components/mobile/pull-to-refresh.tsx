'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

const TRIGGER = 72;

/**
 * Pull down at the top of any phone screen to reload its data (installed apps have no
 * browser pull-to-refresh). Attaches to the app's scroll container.
 */
export function PullToRefresh({ targetId }: { targetId: string }) {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [refreshing, start] = useTransition();
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el || !window.matchMedia('(hover: none)').matches) return;
    const onStart = (e: TouchEvent) => {
      const sheetOpen = document.querySelector('[data-sheet]');
      startY.current = el.scrollTop <= 0 && !sheetOpen ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || el.scrollTop > 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      const d = Math.min(120, dy * 0.5); // resistance
      pullRef.current = d;
      setPull(d);
      if (d > 4 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (pullRef.current >= TRIGGER) {
        navigator.vibrate?.(10);
        start(() => router.refresh());
      }
      startY.current = null;
      pullRef.current = 0;
      setPull(0);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [targetId, router]);

  const visible = refreshing || pull > 0;
  const progress = refreshing ? 1 : Math.min(1, pull / TRIGGER);
  return (
    <div
      aria-hidden={!visible}
      className="md:hidden pointer-events-none fixed left-1/2 z-40 -translate-x-1/2 transition-opacity"
      style={{ top: `calc(env(safe-area-inset-top) + ${refreshing ? 16 : Math.max(0, pull - 28)}px)`, opacity: visible ? 1 : 0 }}
    >
      <div className="w-10 h-10 rounded-full bg-background border border-border shadow-md flex items-center justify-center">
        <RefreshCw
          className={refreshing ? 'w-5 h-5 animate-spin text-foreground' : 'w-5 h-5 text-muted-foreground'}
          style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)`, opacity: 0.4 + progress * 0.6 }}
        />
      </div>
    </div>
  );
}
