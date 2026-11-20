'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, CircleHelp, FolderGit2, FolderOpen, History, LayoutList, NotebookText, PanelsTopLeft, Play, Plus, Search, Settings, X, type LucideIcon } from 'lucide-react';
import { compareHits, isKind, KINDS, marks, parseQuery, SERVER_KINDS, type Hit, type Kind, type KindResult, type SearchResult } from '@/lib/search/match';
import { matchStatic } from '@/lib/search/static';
import { recentKey } from '@/lib/search/recent';
import { useApp } from '@/components/app-context';
import { startClaudeUrl } from '@/lib/nav';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Chip, ChipGroup } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { usePhone } from '@/components/mobile/use-phone';
import { cn } from '@/lib/utils';

/** The server's kinds (app/api/search): every kind, or one with more hits. Null when it failed or was cancelled. */
async function fetchSearch(q: string, kind: Kind | undefined, signal: AbortSignal): Promise<SearchResult | null> {
  const p = new URLSearchParams({ q, ...(kind ? { kind } : {}) });
  try {
    const r = await fetch(`/api/search?${p}`, { signal, cache: 'no-store' });
    return r.ok ? ((await r.json()) as SearchResult) : null;
  } catch {
    return null;
  }
}

export const OPEN_SEARCH_EVENT = 'wos:search';
/** Open global search from anywhere (header icon, sidebar button, shortcut, a list's search button); `kind` picks the filter. */
export const openSearch = (kind?: unknown) => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: isKind(kind) ? kind : null }));

type Filter = 'all' | Kind;
const FILTERS: { key: Filter; label: string }[] = [{ key: 'all', label: 'All' }, ...KINDS.map(k => ({ key: k.key as Filter, label: k.label }))];
const labelOf = (f: Filter) => FILTERS.find(x => x.key === f)!.label;
const ICON: Record<Kind, LucideIcon> = { tasks: LayoutList, projects: FolderOpen, notes: NotebookText, sessions: Bot, needs: CircleHelp, files: FolderGit2, settings: Settings, pages: PanelsTopLeft };
/** Hits per group in All. */
const GROUP = 5;
type Recent = Pick<Hit, 'kind' | 'id' | 'title' | 'meta' | 'right' | 'href' | 'action'>;

/** This person's recent hits (key: recentKey, per person and organization; none before the app knows who it is). */
function readRecent(key: string | null): Recent[] {
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter(r => r && typeof r.href === 'string' && r.href.startsWith('/') && typeof r.title === 'string' && isKind(r.kind)).slice(0, 5) : [];
  } catch {
    return [];
  }
}
function remember(key: string | null, h: Hit) {
  if (!key) return;
  try {
    const r: Recent = { kind: h.kind, id: h.id, title: h.title, meta: h.meta, right: h.right, href: h.href, action: h.action };
    localStorage.setItem(key, JSON.stringify([r, ...readRecent(key).filter(x => x.href !== r.href || x.title !== r.title)].slice(0, 5)));
  } catch {}
}

// ── Deep links into a page: a hit can point at a State line, a Need, the Code section or a Claude tool ──

const TARGETS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^#state-next-(.+)$/, m => `[data-next-id="${CSS.escape(m[1])}"]`],
  [/^#state-later-(.+)$/, m => `[data-later-id="${CSS.escape(m[1])}"]`],
  [/^#state-now$/, () => '[data-state-now]'],
  [/^#state-decisions$/, () => '[data-part="decisions"]'],
  [/^#need-(\d+)$/, m => `[data-need="${m[1]}"]`],
  [/^#tool-([a-z_]+)$/, m => `[data-tool="${m[1]}"]`],
  [/^#code$/, () => '#code'],
];

/** Once `path` is showing, scroll the element the hash names into view (opening folds around it) and outline it briefly. */
function focusTarget(path: string, hash: string) {
  const found = TARGETS.map(([re, sel]) => ({ m: re.exec(hash), sel })).find(x => x.m);
  if (!found) return;
  const selector = found.sel(found.m!);
  const until = Date.now() + 5000;
  const tick = () => {
    if (window.location.pathname === path) {
      const all = [...document.querySelectorAll<HTMLElement>(selector)];
      const el = all.find(e => e.offsetParent !== null) ?? all[0];
      if (el) {
        for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
        el.scrollIntoView({ block: 'center' });
        el.style.outline = '2px solid var(--ring)';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
        }, 1800);
        return;
      }
    }
    if (Date.now() < until) setTimeout(tick, 150);
  };
  tick();
}

/** Spotlight-style search over everything: a 720px dialog on desktop, a full sheet on the phone. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const phone = usePhone();
  const router = useRouter();
  const { me, orgId } = useApp();
  const storeKey = me && orgId ? recentKey(orgId, me) : null;
  const pushed = useRef(false);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const k = (e as CustomEvent).detail;
      setFilter(isKind(k) ? k : 'all');
      setQ('');
      setOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_EVENT, on);
    // A hit opened in a new tab (Ctrl+Enter) lands with its hash: focus it here too.
    if (window.location.hash) focusTarget(window.location.pathname, window.location.hash);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, on);
  }, []);

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
      if (href) {
        const u = new URL(href, window.location.href);
        if (u.hash) focusTarget(u.pathname, u.hash);
      }
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

  const choose = useCallback(
    (h: Hit, newTab: boolean) => {
      remember(storeKey, h);
      if (h.action === 'quick-add') {
        close();
        setTimeout(() => window.dispatchEvent(new Event('wos:quick-add')), 60);
      } else if (h.action === 'start-claude') close(startClaudeUrl());
      else if (newTab) window.open(h.href, '_blank', 'noopener');
      else close(h.href);
    },
    [close, storeKey],
  );

  /** Esc clears the text first, then closes. */
  const escape = useCallback(() => {
    if (q) setQ('');
    else dismiss();
  }, [q, dismiss]);

  if (!open) return null;
  const panel = <Panel q={q} setQ={setQ} filter={filter} setFilter={setFilter} phone={phone} storeKey={storeKey} onChoose={choose} onClose={dismiss} />;
  if (phone) return <PhoneSheet onEscape={escape}>{panel}</PhoneSheet>;
  return (
    <Dialog
      open
      onOpenChange={(v, d) => {
        if (v) return;
        if (d.reason === 'escape-key' && q) setQ('');
        else dismiss();
      }}
    >
      <DialogContent size="wide" className="p-0 gap-0 overflow-hidden top-[12vh] translate-y-0" showCloseButton={false} data-global-search>
        <DialogTitle className="sr-only">Search</DialogTitle>
        {panel}
      </DialogContent>
    </Dialog>
  );
}

/** Phone: a full sheet, input pinned on top. Carries data-sheet (pull to refresh ignores it). */
function PhoneSheet({ onEscape, children }: { onEscape: () => void; children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onEscape();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [onEscape]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="Search"
      data-sheet
      data-global-search
      className="md:hidden fixed inset-0 z-50 flex flex-col bg-background text-foreground animate-in slide-in-from-bottom duration-200"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {children}
    </div>,
    document.body,
  );
}

type Item = { type: 'hit'; hit: Hit } | { type: 'more'; kind: Kind; count: string };
type PanelProps = { q: string; setQ: (v: string) => void; filter: Filter; setFilter: (f: Filter) => void; phone: boolean; storeKey: string | null; onChoose: (h: Hit, newTab: boolean) => void; onClose: () => void };

function Panel({ q, setQ, filter, setFilter, phone, storeKey, onChoose, onClose }: PanelProps) {
  const [all, setAll] = useState<SearchResult | null>(null);
  const [one, setOne] = useState<{ q: string; kind: Kind; res: KindResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [recent] = useState<Recent[]>(() => (typeof window === 'undefined' ? [] : readRecent(storeKey)));
  const seq = useRef(0);
  const seqOne = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const text = q.trim();
  const query = useMemo(() => (text ? parseQuery(text) : null), [text]);

  // Every kind (the groups and each filter's count), as you type. Older results stay until the new ones come.
  useEffect(() => {
    if (!text) return;
    const id = ++seq.current;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetchSearch(text, undefined, ac.signal);
        if (id === seq.current && r) setAll(r);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [text]);
  // One kind chosen: more of it.
  useEffect(() => {
    if (!text || filter === 'all' || !SERVER_KINDS.includes(filter)) return;
    const id = ++seqOne.current;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      const r = await fetchSearch(text, filter, ac.signal);
      const res = r?.kinds[filter];
      if (id === seqOne.current && res) setOne({ q: text, kind: filter, res });
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [text, filter]);
  const [selKey, setSelKey] = useState(`${text}|${filter}`);
  if (selKey !== `${text}|${filter}`) {
    setSelKey(`${text}|${filter}`);
    setSel(0);
  }

  const local = useMemo(() => ({ settings: matchStatic('settings', query), pages: matchStatic('pages', query) }), [query]);

  /** A kind's hits and count: the server's (more of them when that kind is chosen), with the browser's Settings and Pages. */
  const kindResult = useCallback(
    (k: Kind, more: boolean): KindResult => {
      if (k === 'settings') return { hits: local.settings, count: local.settings.length };
      const counted = (text && all?.kinds[k]) || { hits: [], count: 0 };
      const server = (more && one && one.kind === k && one.q === text ? one.res : counted) as KindResult;
      if (k !== 'pages') return { ...server, count: Math.max(server.count, counted.count), more: server.more || counted.more };
      return { hits: [...local.pages, ...server.hits].sort(compareHits), count: local.pages.length + Math.max(server.count, counted.count) };
    },
    [local, one, all, text],
  );

  const counts = useMemo(() => {
    const m = new Map<Filter, number>();
    if (!text) return m;
    let total = 0;
    for (const k of KINDS) {
      const n = kindResult(k.key, false).count;
      m.set(k.key, n);
      total += n;
    }
    m.set('all', total);
    return m;
  }, [kindResult, text]);

  // What the list shows, and the order the arrows walk.
  const { items, sections } = useMemo(() => {
    const items: Item[] = [];
    const sections: { key: string; label: string; icon?: LucideIcon; from: number; to: number }[] = [];
    const section = (key: string, label: string, icon: LucideIcon | undefined, add: () => void) => {
      const from = items.length;
      add();
      if (items.length > from) sections.push({ key, label, icon, from, to: items.length });
    };
    const hits = (list: Hit[]) => list.forEach(hit => items.push({ type: 'hit', hit }));
    if (!text) {
      if (filter === 'all') {
        section('recent', 'Recent', History, () => hits(recent.map(r => ({ ...r, tier: 4, open: true, mine: true, at: 0 }))));
        section('pages', 'Pages', PanelsTopLeft, () => hits(local.pages));
      } else if (filter === 'settings' || filter === 'pages') section(filter, labelOf(filter), ICON[filter], () => hits(local[filter]));
      return { items, sections };
    }
    if (filter !== 'all') {
      section(filter, labelOf(filter), ICON[filter], () => hits(kindResult(filter, true).hits));
      return { items, sections };
    }
    const groups = KINDS.map(k => ({ k: k.key, label: k.label, r: kindResult(k.key, false) })).filter(g => g.r.hits.length);
    const best = groups.map(g => g.r.hits[0]).sort(compareHits)[0];
    if (best) section('best', 'Best match', undefined, () => hits([best]));
    groups.sort((a, b) => compareHits(a.r.hits[0], b.r.hits[0]));
    for (const g of groups) {
      const rest = g.r.hits.filter(h => h !== best).slice(0, GROUP);
      const shown = rest.length + (g.r.hits.includes(best) ? 1 : 0);
      section(g.k, g.label, ICON[g.k], () => {
        hits(rest);
        if (g.r.count > shown || g.r.more) items.push({ type: 'more', kind: g.k, count: `${g.r.count}${g.r.more ? '+' : ''}` });
      });
    }
    return { items, sections };
  }, [text, filter, recent, local, kindResult]);

  const words = query?.words ?? [];
  const zero = (f: Filter) => !!text && f !== 'all' && f !== filter && counts.get(f) === 0;
  const usable = FILTERS.filter(f => !zero(f.key));

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setSel(s => (s + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[sel];
      if (it?.type === 'more') setFilter(it.kind);
      else if (it) onChoose(it.hit, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = usable.findIndex(f => f.key === filter);
      setFilter(usable[(i + (e.shiftKey ? -1 : 1) + usable.length) % usable.length].key);
      inputRef.current?.focus();
    }
  }
  useEffect(() => {
    listRef.current?.querySelector(`[data-hit="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const filterText = (f: { key: Filter; label: string }) => {
    const n = counts.get(f.key);
    return (
      <>
        <span className="truncate">{f.label}</span>
        {n !== undefined && <span className={cn('tabular-nums', f.key === filter ? 'opacity-80' : 'text-muted-foreground')}>{n}</span>}
      </>
    );
  };

  const input = (
    <div className="flex items-center gap-2 px-4 h-14 border-b border-border/60 shrink-0">
      <Search className="w-4 h-4 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        value={q}
        onChange={e => setQ(e.target.value.slice(0, 80))}
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls="global-search-results"
        aria-activedescendant={items.length ? `hit-${sel}` : undefined}
        aria-label="Search tasks, projects, notes, sessions, Needs, files, settings and pages"
        placeholder={filter === 'all' ? 'Search everything, #12 or N3' : `Search ${labelOf(filter).toLowerCase()}`}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        className="flex-1 min-w-0 h-11 bg-transparent text-base md:text-body outline-none placeholder:text-muted-foreground"
      />
      {q && (
        <IconButton label="Clear" onClick={() => (setQ(''), inputRef.current?.focus())} className="-mr-1">
          <X className="w-4 h-4" />
        </IconButton>
      )}
      {phone ? (
        <Button variant="ghost" size="touch" onClick={onClose} className="-mr-3 px-3">
          Cancel
        </Button>
      ) : (
        <kbd className="text-label font-mono border border-border rounded px-1 text-muted-foreground">Esc</kbd>
      )}
    </div>
  );

  const list = (
    <div id="global-search-results" ref={listRef} role="listbox" aria-label="Results" className={cn('flex-1 overflow-y-auto overscroll-contain min-w-0', phone ? 'px-2 pb-6' : 'p-2')}>
      {!text && filter !== 'all' && filter !== 'settings' && filter !== 'pages' && <p className="px-3 py-6 text-meta text-muted-foreground">Type to search {labelOf(filter).toLowerCase()}.</p>}
      {text && items.length === 0 && !busy && all && (
        <p className="px-3 py-6 text-meta text-muted-foreground">
          No matches for &ldquo;{text}&rdquo;{filter !== 'all' ? ` in ${labelOf(filter)}` : ''}.
        </p>
      )}
      {sections.map(s => (
        <section key={s.key} aria-label={s.label} className="mb-1.5">
          <h3 className="px-3 pt-2 pb-1 text-label font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            {s.icon && <s.icon className="w-3 h-3" />} {s.label}
          </h3>
          {items.slice(s.from, s.to).map((it, k) => {
            const i = s.from + k;
            if (it.type === 'more')
              return (
                <a
                  key={'more' + it.kind}
                  id={`hit-${i}`}
                  data-hit={i}
                  data-more={it.kind}
                  role="option"
                  aria-selected={i === sel}
                  href="#"
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={e => (e.preventDefault(), setFilter(it.kind))}
                  className={cn('flex items-center pl-10 pr-3 rounded-lg min-h-11 md:min-h-9 text-meta text-muted-foreground', i === sel ? 'bg-muted text-foreground' : 'hover:text-foreground')}
                >
                  Show all {it.count}
                </a>
              );
            return <HitRow key={it.hit.kind + it.hit.id} hit={it.hit} i={i} on={i === sel} words={words} onHover={() => i !== sel && setSel(i)} onChoose={newTab => onChoose(it.hit, newTab)} />;
          })}
        </section>
      ))}
    </div>
  );

  if (phone) {
    return (
      <div onKeyDown={onKey} className="flex flex-col min-h-0 flex-1">
        {input}
        <ChipGroup scroll label="Filter" className="px-4 py-2 shrink-0 border-b border-border/60">
          {FILTERS.map(f => (
            <Chip key={f.key} selected={f.key === filter} disabled={zero(f.key)} onClick={() => setFilter(f.key)} data-filter={f.key}>
              {filterText(f)}
            </Chip>
          ))}
        </ChipGroup>
        {list}
      </div>
    );
  }
  return (
    <div onKeyDown={onKey} className="flex flex-col min-h-0 max-h-[70vh]">
      {input}
      <div className="flex min-h-0 flex-1">
        {list}
        <div role="group" aria-label="Filter" className="w-40 shrink-0 border-l border-border/60 p-2 space-y-0.5 overflow-y-auto">
          {FILTERS.map(f => (
            <Button
              key={f.key}
              variant="ghost"
              aria-pressed={f.key === filter}
              data-filter={f.key}
              disabled={zero(f.key)}
              tabIndex={-1}
              onClick={() => (setFilter(f.key), inputRef.current?.focus())}
              className={cn('w-full justify-between h-8 px-2.5 text-meta font-normal', f.key === filter ? 'bg-muted font-medium text-foreground' : 'text-foreground/80')}
            >
              {filterText(f)}
            </Button>
          ))}
          <p className="px-2.5 pt-2 text-label text-muted-foreground leading-snug">Tab and Shift+Tab move between filters</p>
        </div>
      </div>
    </div>
  );
}

/** Two lines: kind icon, title with the matched words bold, the meta or a piece of the text; project and status on the right. */
function HitRow({ hit, i, on, words, onHover, onChoose }: { hit: Hit; i: number; on: boolean; words: string[]; onHover: () => void; onChoose: (newTab: boolean) => void }) {
  const Icon = hit.action === 'start-claude' ? Play : hit.meta === 'Action' ? Plus : ICON[hit.kind];
  const second = [hit.meta, hit.snippet].filter(Boolean).join(' · ');
  return (
    <a
      id={`hit-${i}`}
      data-hit={i}
      data-kind={hit.kind}
      role="option"
      aria-selected={on}
      href={hit.href}
      onMouseMove={onHover}
      onClick={e => {
        // Ctrl/Cmd/Shift-click and middle-click keep the browser's own new tab or window.
        if (!hit.action && (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0)) return;
        e.preventDefault();
        onChoose(false);
      }}
      className={cn('flex items-center gap-3 px-3 rounded-lg min-h-11 md:min-h-12 py-1.5', on ? 'bg-muted' : 'active:bg-muted')}
    >
      <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base md:text-body text-foreground">
          <Marked text={hit.title} words={words} />
        </span>
        {(second || hit.right) && (
          <span className="block truncate text-meta text-muted-foreground">
            {/* Phone: project and status lead the second line (no room on the right). */}
            {hit.right && <span className="md:hidden">{hit.right}{second ? ' · ' : ''}</span>}
            <Marked text={second} words={words} />
          </span>
        )}
      </span>
      {hit.right && <span className="hidden md:block shrink-0 max-w-[40%] truncate text-meta text-muted-foreground">{hit.right}</span>}
    </a>
  );
}

function Marked({ text, words }: { text: string; words: string[] }) {
  const parts = useMemo(() => marks(text, words), [text, words]);
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <b key={k} className="font-semibold text-foreground">
            {p.text}
          </b>
        ) : (
          <span key={k}>{p.text}</span>
        ),
      )}
    </>
  );
}
