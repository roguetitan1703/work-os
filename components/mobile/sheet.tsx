'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Phone bottom sheet. Portalled to <body> so sticky/blurred ancestors (which trap `fixed`) can't clip it.
 * Carries `data-sheet` so pull-to-refresh ignores it.
 */
export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="md:hidden fixed inset-0 z-50" data-sheet>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />
      <div
        role="dialog"
        aria-label={title}
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-background text-foreground shadow-2xl animate-in slide-in-from-bottom duration-200"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <div className="mx-auto mt-2.5 mb-1 h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        <div className="flex items-center justify-between px-4 pt-1">
          <span className="text-sm font-semibold text-muted-foreground">{title}</span>
          <button type="button" onClick={onClose} className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 pb-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
