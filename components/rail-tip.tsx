'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';

/** A small tooltip (label and shortcut) to the right of its child, for the collapsed sidebar. `on` false: no tooltip. */
export function RailTip({ on, label, hint, children }: { on: boolean; label: string; hint?: string; children: React.ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!on) return <>{children}</>;
  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: r.right + 8, y: r.top + r.height / 2 });
  };
  return (
    <div onMouseEnter={show} onMouseLeave={() => setAt(null)} onFocus={show} onBlur={() => setAt(null)} onPointerDown={() => setAt(null)}>
      {children}
      {at &&
        createPortal(
          <div role="tooltip" style={{ left: at.x, top: at.y }} className="pointer-events-none fixed z-[300] -translate-y-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
            {label}
            {hint && <span className="ml-2 font-mono text-muted-foreground">{hint}</span>}
          </div>,
          document.body,
        )}
    </div>
  );
}
