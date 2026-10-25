'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { openSearch } from '@/components/global-search';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const PLACES: Record<string, string> = { '1': '/today', '2': '/tasks', '3': '/projects', '4': '/notes', '5': '/claude' };

export const SHORTCUTS: [string, string][] = [
  ['N', 'New task'],
  ['S', 'Start Claude'],
  ['1', 'Today'],
  ['2', 'Tasks'],
  ['3', 'Projects'],
  ['4', 'Notes'],
  ['5', 'Claude'],
  ['/', 'Search'],
  ['Ctrl+B', 'Collapse or expand the sidebar'],
  ['Ctrl+,', 'Settings'],
  ['Ctrl+K', 'Search (also while typing)'],
  ['?', 'This help'],
  ['Shift+Enter', 'Full form (in quick add)'],
  ['Ctrl+Enter', 'Add comment (in a comment)'],
];

/** Desktop keyboard shortcuts: 1-5 go to the five places, / searches, ? shows help. Inactive while typing or with a dialog open. */
export function GlobalShortcuts() {
  const router = useRouter();
  const [help, setHelp] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (!window.matchMedia('(min-width: 768px)').matches) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!document.querySelector('[data-global-search]')) openSearch();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === '/' && e.shiftKey) {
        e.preventDefault();
        setHelp(true);
      } else if (PLACES[e.key]) {
        e.preventDefault();
        router.push(PLACES[e.key]);
      } else if (e.key === '/') {
        e.preventDefault();
        openSearch();
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <Dialog open={help} onOpenChange={setHelp}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="space-y-1.5 text-sm">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{d}</dt>
              <dd>
                <kbd className="text-[11px] font-mono border border-border rounded px-1.5 py-0.5">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-muted-foreground">Shortcuts work when you are not typing and no dialog is open.</p>
      </DialogContent>
    </Dialog>
  );
}
