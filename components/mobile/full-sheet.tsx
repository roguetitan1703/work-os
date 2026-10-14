'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Phone full-height sheet with a scrolling body and a pinned footer (for long forms).
 * Portalled to <body>; carries `data-sheet` so pull-to-refresh ignores it.
 */
export function FullSheet({ title, onClose, footer, children }: { title: string; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      data-sheet
      className="md:hidden fixed inset-0 z-50 flex flex-col bg-background text-foreground animate-in slide-in-from-bottom duration-200"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center justify-between gap-2 px-4 h-14 shrink-0 border-b border-border/60">
        <h2 className="text-[17px] font-semibold truncate">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      {footer && (
        <div className="shrink-0 border-t border-border/60 bg-background px-4 pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}>
          {footer}
        </div>
      )}
    </div>,
    document.body,
  );
}
