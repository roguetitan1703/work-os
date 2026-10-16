'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderOpen, LayoutList, NotebookText, Search, Sparkles, X } from 'lucide-react';
import { searchAction } from '@/app/(app)/search-action';
import type { SearchHit, SearchResult } from '@/lib/data/search';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { FullSheet } from '@/components/mobile/full-sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { cn } from '@/lib/utils';

export const OPEN_SEARCH_EVENT = 'wos:search';
/** Open global search from anywhere (header icon, sidebar button, shortcut). */
export const openSearch = () => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));

const GROUPS: { key: 'tasks' | 'projects' | 'notes' | 'claude'; label: string; icon: typeof Search }[] = [
  { key: 'tasks', label: 'Tasks', icon: LayoutList },
  { key: 'projects', label: 'Projects', icon: FolderOpen },
  { key: 'notes', label: 'Notes', icon: NotebookText },
  { key: 'claude', label: 'Claude', icon: Sparkles },
];

/** Search tasks, projects, notes and Claude items. Full-screen sheet on phone, dialog on desktop; up/down/Enter on desktop. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_SEARCH_EVENT, on);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, on);
  }, []);
  const router = useRouter();
  const pushed = useRef(false);
  const pending = useRef<string | null>(null);

  // Phone: the sheet owns one history entry, so the Back gesture closes it instead of leaving the page.
  useEffect(() => {
    if (!open || !phone) return;
    window.history.pushState({ ...window.history.state, wosSearch: 1 }, '');
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      setOpen(false);
      if (pending.current) router.push(pending.current);
      pending.current = null;
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      }
    };
  }, [open, phone, router]);

  /** Close the search; with an href, go there afterwards (after the sheet's history entry is popped). */
  const close = useCallback(
    (href?: string) => {
      if (pushed.current) {
        pending.current = href ?? null;
        window.history.back(); // popstate handler closes and navigates
        return;
      }
      setOpen(false);
      if (href) router.push(href);
    },
    [router],
  );
  const dismiss = useCallback(() => close(), [close]);
  if (!open) return null;
  if (phone) {
    return (
      <FullSheet title="Search" onClose={dismiss}>
        <Panel onDone={close} phone />
      </FullSheet>
    );
  }
  return (
    <Dialog open onOpenChange={v => !v && dismiss()}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden" showCloseButton={false} data-global-search>
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Panel onDone={close} phone={false} />
      </DialogContent>
    </Dialog>
  );
}

function Panel({ onDone, phone }: { onDone: (href?: string) => void; phone: boolean }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const text = q.trim();
    if (!text) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await searchAction(text);
        if (id === seq.current) {
          setRes(r);
          setSel(0);
        }
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const shown = q.trim() ? res : null;
  const flat = useMemo<SearchHit[]>(() => (shown ? GROUPS.flatMap(g => shown[g.key]) : []), [shown]);

  function go(h: SearchHit) {
    onDone(h.href);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setSel(s => (s + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter' && flat[sel]) {
      e.preventDefault();
      go(flat[sel]);
    }
  }
  useEffect(() => {
    document.querySelector(`[data-hit="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  let idx = -1;
  return (
    <div onKeyDown={onKey} className="flex flex-col min-h-0">
      <div className={cn('flex items-center gap-2 border-b border-border/60', phone ? 'pb-3 -mt-1' : 'px-4 h-12')}>
        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value.slice(0, 80))}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="global-search-results"
          aria-activedescendant={flat.length ? `hit-${sel}` : undefined}
          aria-label="Search tasks, projects, notes and Claude items"
          placeholder="Search tasks, projects, notes, #12 or C12"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          className="flex-1 min-w-0 h-11 bg-transparent text-[16px] md:text-sm outline-none placeholder:text-muted-foreground"
        />
        {q && (
          <button type="button" aria-label="Clear" onClick={() => (setQ(''), inputRef.current?.focus())} className="w-11 h-11 -mr-2 flex items-center justify-center text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
        {!phone && <kbd className="text-[10px] font-mono border border-border rounded px-1 text-muted-foreground">Esc</kbd>}
      </div>
      <div id="global-search-results" role="listbox" className={cn('overflow-y-auto overscroll-contain', phone ? 'pt-2' : 'max-h-[60vh] p-2')}>
        {!q.trim() && (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            Type to search. Try a title, a note&apos;s words, <span className="font-mono">#12</span> or <span className="font-mono">C12</span>.
          </p>
        )}
        {shown && flat.length === 0 && !busy && <p className="px-2 py-6 text-sm text-muted-foreground">No matches for &ldquo;{shown.q}&rdquo;.</p>}
        {shown &&
          GROUPS.map(g => {
            const hits = shown[g.key];
            if (!hits.length) return null;
            return (
              <section key={g.key} aria-label={g.label} className="mb-2">
                <h3 className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <g.icon className="w-3 h-3" /> {g.label}
                </h3>
                {hits.map(h => {
                  idx += 1;
                  const i = idx;
                  return (
                    <button
                      key={h.kind + h.id}
                      id={`hit-${i}`}
                      data-hit={i}
                      role="option"
                      aria-selected={i === sel}
                      type="button"
                      onMouseMove={() => i !== sel && setSel(i)}
                      onClick={() => go(h)}
                      className={cn('w-full text-left px-3 rounded-lg flex flex-col justify-center min-h-11 py-1.5', i === sel ? 'bg-muted' : 'active:bg-muted')}
                    >
                      <span className="text-[16px] md:text-sm text-foreground truncate">{h.title}</span>
                      {h.meta && <span className="text-xs text-muted-foreground truncate">{h.meta}</span>}
                    </button>
                  );
                })}
              </section>
            );
          })}
      </div>
    </div>
  );
}
