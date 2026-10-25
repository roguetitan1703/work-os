'use client';

import { Ago } from '@/components/ago';
import { useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronsUp, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { BottomSheet } from '@/components/mobile/sheet';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ActorName, PersonName } from '@/components/actor-badge';
import { cn } from '@/lib/utils';
import { CLAUDE_ITEM_KINDS, CLAUDE_ITEM_STATES, type ClaudeItem } from '@/lib/types';
import { write } from '../../claude/auto-refresh';
import { moveClaudeItemAction, updateClaudeItemAction } from './claude-items-actions';

export type Blocker = { ref: number; title: string; state: string };
type Props = { projectId: string; items: ClaudeItem[]; blockers: Record<string, Blocker>; waiting: number; doneCount: number; openRef?: number };

const KIND_STYLE: Record<string, string> = {
  feature: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  bug: 'bg-red-500/10 text-red-700 dark:text-red-300',
  debt: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  idea: 'bg-muted text-muted-foreground',
};
const field =
  'h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5 border border-border bg-card hover:bg-muted/60 active:bg-muted';
const LIST = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border divide-y divide-border/60 md:divide-border bg-card overflow-hidden';

const ref = (n: number) => `C${n}`;

function useDesktop() {
  return useSyncExternalStore(
    cb => {
      const m = window.matchMedia('(min-width: 768px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(min-width: 768px)').matches,
    () => false,
  );
}

export function Chip({ kind }: { kind: string }) {
  return <span className={cn('text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0', KIND_STYLE[kind])}>{kind}</span>;
}

/** Claude's own work list for a project (separate from the people's tasks). */
export function ClaudeItems({ projectId, items, blockers, waiting: waitingCount, doneCount, openRef }: Props) {
  const [sel, setSel] = useState<number | null>(openRef ?? null);
  const [showDone, setShowDone] = useState(false);
  // A new ?claude= link opens that item (adjusting state during render, not in an effect).
  const [seenRef, setSeenRef] = useState(openRef);
  if (seenRef !== openRef) {
    setSeenRef(openRef);
    setSel(openRef ?? null);
  }

  const open = items.filter(i => i.state !== 'done' && i.state !== 'dropped');
  const finished = items.filter(i => i.state === 'done' || i.state === 'dropped');
  const waiting = open.filter(i => i.waitingOn);
  const rest = open.filter(i => !i.waitingOn);
  const active = rest.filter(i => i.state === 'active');
  const ideas = rest.filter(i => i.state !== 'active' && i.kind === 'idea');
  const blocked = rest.filter(i => i.state === 'blocked' && i.kind !== 'idea');
  const queued = rest.filter(i => i.state === 'queued' && i.kind !== 'idea');
  const nextUp = queued.filter(i => i.next);
  const plain = queued.filter(i => !i.next);

  const group = (title: string, list: ClaudeItem[], tone?: string) =>
    list.length > 0 && (
      <div className="space-y-1">
        <h3 className={cn('text-[11px] font-semibold uppercase tracking-wider px-1 md:px-0', tone ?? 'text-muted-foreground')}>
          {title} · {list.length}
        </h3>
        <ul className={LIST}>
          {list.map(i => (
            <Row key={i.id} item={i} blocker={i.blockedBy ? blockers[i.blockedBy] : undefined} onOpen={() => setSel(i.ref)} />
          ))}
        </ul>
      </div>
    );

  return (
    <section className="space-y-3" id="claude-work">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 md:px-0">Queue</h2>
        <span className="text-xs text-muted-foreground">
          {open.length} open · {doneCount} done
        </span>
        {waitingCount > 0 && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">{waitingCount} waiting on a person</span>
        )}
      </div>
      {group('Waiting on you', waiting, 'text-amber-700 dark:text-amber-300')}
      {group('Active', active)}
      {group('Next up', nextUp)}
      {group('Queued', plain)}
      {group('Blocked', blocked)}
      {group('Ideas', ideas)}
      {(finished.length > 0 || doneCount > 0) && (
        <div className="space-y-1">
          <button type="button" onClick={() => setShowDone(v => !v)} className="flex items-center gap-1 min-h-11 md:min-h-0 px-1 md:px-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {showDone ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Done · {doneCount}
          </button>
          {showDone && (
            <ul className={LIST}>
              {finished.map(i => (
                <Row key={i.id} item={i} onOpen={() => setSel(i.ref)} />
              ))}
            </ul>
          )}
        </div>
      )}
      <ItemSheet projectId={projectId} items={items} blockers={blockers} sel={sel} onClose={() => setSel(null)} />
    </section>
  );
}

/** The item sheet (dialog on desktop, bottom sheet on phone) for the item with ref `sel`. Shared by the project page and /claude Queue. */
export function ItemSheet({ projectId, items, blockers, sel, onClose }: { projectId: string; items: ClaudeItem[]; blockers: Record<string, Blocker>; sel: number | null; onClose: () => void }) {
  const desktop = useDesktop();
  const open = items.filter(i => i.state !== 'done' && i.state !== 'dropped');
  // The page refresh after an action can arrive late (or not at all), so the sheet also keeps the item as the action returned it
  // and shows whichever copy is newer.
  const [saved, setSaved] = useState<Record<string, ClaudeItem>>({});
  const fromPage = sel === null ? null : items.find(i => i.ref === sel) ?? null;
  const selected = fromPage && saved[fromPage.id] && saved[fromPage.id].updatedAt > fromPage.updatedAt ? saved[fromPage.id] : fromPage;
  // Same on server and first client render: portals and dialogs only after mount.
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const groupOf = (i: ClaudeItem) => (i.waitingOn ? 'w' : i.state === 'active' ? 'a' : i.kind === 'idea' ? 'i' : i.state === 'blocked' ? 'b' : i.next ? 'n' : 'q');
  // Places to the nearest item in the same group, up (-1) or down (+1), in the project order; 0 when none.
  const hopsTo = (dir: -1 | 1) => {
    if (!selected) return 0;
    const at = open.findIndex(i => i.id === selected.id);
    for (let j = at + dir; j >= 0 && j < open.length; j += dir) if (groupOf(open[j]) === groupOf(selected)) return Math.abs(j - at);
    return 0;
  };
  if (!selected || !mounted) return null;
  const detail = (
    <Detail
      projectId={projectId}
      item={selected}
      onSaved={it => setSaved(m => ({ ...m, [it.id]: it }))}
      blocker={selected.blockedBy ? blockers[selected.blockedBy] : undefined}
      up={hopsTo(-1)}
      down={hopsTo(1)}
      first={open[0]?.id === selected.id}
    />
  );
  return desktop ? (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[85dvh] overflow-y-auto block">
        <DialogTitle className="sr-only">
          {ref(selected.ref)} {selected.title}
        </DialogTitle>
        {detail}
      </DialogContent>
    </Dialog>
  ) : (
    <BottomSheet title={ref(selected.ref)} onClose={onClose}>
      {detail}
    </BottomSheet>
  );
}

function Row({ item: i, blocker, onOpen }: { item: ClaudeItem; blocker?: Blocker; onOpen: () => void }) {
  const parts = i.parts.length ? `${i.parts.filter(p => p.done).length}/${i.parts.length}` : '';
  const finished = i.state === 'done' || i.state === 'dropped';
  return (
    <li>
      <button type="button" onClick={onOpen} className={cn('w-full text-left flex items-start gap-2 px-4 md:px-3 py-3 md:py-2 min-h-14 md:min-h-0 hover:bg-muted/50 active:bg-muted/60', finished && 'opacity-70')}>
        <span className="font-mono text-xs text-muted-foreground shrink-0 pt-1 w-9">{ref(i.ref)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip kind={i.kind} />
            <span className={cn('text-[16px] md:text-sm font-medium', i.state === 'dropped' && 'line-through')}>{i.title}</span>
            {i.next && i.state === 'queued' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 dark:text-green-300 font-medium">next</span>}
            {parts && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">parts {parts}</span>}
          </div>
          {i.state === 'active' && i.claimedBy && <div className="text-xs text-muted-foreground">in {i.claimedBy.session}</div>}
          {i.waitingOn && <div className="text-xs text-amber-700 dark:text-amber-300 line-clamp-2">{i.waitingText}</div>}
          {i.state === 'blocked' && blocker && !i.waitingOn && (
            <div className="text-xs text-muted-foreground">
              waits on {ref(blocker.ref)} {blocker.title}
            </div>
          )}
          {finished && (
            <div className="text-xs text-muted-foreground">
              {i.state}
              {i.gitRef && (
                <>
                  {' · '}
                  <span className="font-mono">{i.gitRef}</span>
                </>
              )}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function Detail({ projectId, item: i, onSaved, blocker, up, down, first }: { projectId: string; item: ClaudeItem; onSaved: (item: ClaudeItem) => void; blocker?: Blocker; up: number; down: number; first: boolean }) {
  // Plain flag, not useTransition: the transition stayed pending after the action's revalidation, which left every control disabled.
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const isOpen = i.state !== 'done' && i.state !== 'dropped';

  const go = async (fn: () => Promise<{ ok: true; item?: ClaudeItem } | { ok: false; error: string }>, after?: () => void) => {
    setPending(true);
    try {
      const r = await write(fn);
      if (!r.ok) return void toast.error(r.error);
      if (r.item) onSaved(r.item);
      after?.();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setPending(false);
    }
  };
  const patch = (p: Parameters<typeof updateClaudeItemAction>[2], after?: () => void) => go(() => updateClaudeItemAction(projectId, i.id, p), after);
  const move = (d: 'up' | 'down' | 'top') => go(() => moveClaudeItemAction(projectId, i.id, d, d === 'up' ? up : down));

  return (
    <div className="space-y-4 pb-2">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{ref(i.ref)}</span>
          <Chip kind={i.kind} />
          <span className="text-xs text-muted-foreground">{i.state}</span>
          {i.gitRef && <span className="font-mono text-xs text-muted-foreground truncate">{i.gitRef}</span>}
        </div>
        <h3 className="text-lg md:text-base font-semibold leading-snug">{i.title}</h3>
        {i.state === 'active' && i.claimedBy && <div className="text-xs text-muted-foreground">in {i.claimedBy.session}</div>}
        {blocker && (
          <div className="text-xs text-muted-foreground">
            waits on {ref(blocker.ref)} {blocker.title} ({blocker.state})
          </div>
        )}
      </div>

      {i.waitingOn && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">Claude is waiting on <PersonName userId={i.waitingOn} /></div>
          <p className="text-sm whitespace-pre-wrap">{i.waitingText}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-full min-w-0 flex-1 basis-full md:basis-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm outline-none focus-visible:border-ring"
              value={answer}
              maxLength={1000}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && answer.trim() && !pending && patch({ waitingText: '', note: answer.trim() }, () => setAnswer(''))}
              placeholder="Your answer…"
              aria-label={`Your answer to C${i.ref}`}
              enterKeyHint="send"
            />
            <button type="button" disabled={pending || !answer.trim()} onClick={() => patch({ waitingText: '', note: answer.trim() }, () => setAnswer(''))} className={cn(btn, 'bg-foreground text-background border-foreground hover:bg-foreground/90')}>
              Send answer
            </button>
            <button type="button" disabled={pending} onClick={() => patch({ waitingText: '' })} className="h-11 md:h-auto px-2 text-[13px] md:text-xs text-muted-foreground underline disabled:opacity-50">
              Close without answer
            </button>
          </div>
        </div>
      )}
      {!i.waitingOn && i.answer && (
        <div className="rounded-xl border border-border p-3 space-y-1 text-sm" data-answer>
          <div className="text-xs text-muted-foreground">Claude asked</div>
          <p className="whitespace-pre-wrap">{i.answer.question}</p>
          <div className="text-xs text-muted-foreground pt-1"><PersonName userId={i.answer.by} /> answered <Ago iso={i.answer.at} /></div>
          <p className="whitespace-pre-wrap">{i.answer.text || <span className="text-muted-foreground">Closed without an answer</span>}</p>
        </div>
      )}

      <Text label="Why" text={i.why} />
      <Text label="Done when" text={i.doneWhen} />
      <Text label="Note" text={i.note} />

      {i.parts.length > 0 && (
        <div className="space-y-1">
          <Label>Parts</Label>
          <ul className="space-y-1">
            {i.parts.map(p => (
              <li key={p.id} className="flex items-start gap-2 text-sm">
                <span aria-hidden className={cn('mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px]', p.done ? 'bg-green-500 border-green-500 text-white' : 'border-border')}>
                  {p.done ? '✓' : ''}
                </span>
                <span className={cn(p.done && 'line-through text-muted-foreground')}>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <Label>Change</Label>
        <div className="flex gap-2 flex-wrap">
          <select aria-label="State" value={i.state} disabled={pending} onChange={e => patch({ state: e.target.value as ClaudeItem['state'] })} className={field}>
            {CLAUDE_ITEM_STATES.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select aria-label="Kind" value={i.kind} disabled={pending} onChange={e => patch({ kind: e.target.value as ClaudeItem['kind'] })} className={field}>
            {CLAUDE_ITEM_KINDS.map(k => (
              <option key={k} value={k}>
                {k === 'idea' ? 'idea' : `make it a ${k}`}
              </option>
            ))}
          </select>
          {i.kind !== 'idea' && i.state === 'queued' && (
            <button type="button" aria-pressed={i.next} disabled={pending} onClick={() => patch({ next: !i.next })} className={cn(btn, i.next && 'bg-green-500/15 border-green-500/40 text-green-700 dark:text-green-300')}>
              Next{i.next ? ': on' : ''}
            </button>
          )}
        </div>
        {isOpen && (
          <div className="flex gap-2">
            <button type="button" disabled={pending || !up} onClick={() => move('up')} className={btn} aria-label="Move up">
              <ArrowUp className="w-4 h-4" /> Up
            </button>
            <button type="button" disabled={pending || !down} onClick={() => move('down')} className={btn} aria-label="Move down">
              <ArrowDown className="w-4 h-4" /> Down
            </button>
            <button type="button" disabled={pending || first} onClick={() => move('top')} className={btn} aria-label="Move to top">
              <ChevronsUp className="w-4 h-4" /> Top
            </button>
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (note.trim()) patch({ note }, () => setNote(''));
          }}
        >
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note for Claude" aria-label="Add note" className={cn(field, 'flex-1 min-w-0')} />
          <button type="submit" disabled={pending || !note.trim()} className={btn}>
            Add
          </button>
        </form>
      </div>

      {i.log.length > 0 && (
        <div className="space-y-1">
          <Label>Log</Label>
          <ul className="space-y-1.5">
            {[...i.log].reverse().map((l, n) => (
              <li key={n} className="text-xs">
                <span className="text-muted-foreground">
                  <Ago iso={l.at} /> · <ActorName actor={l.actor} />
                  {l.session ? ` · ${l.session}` : ''}
                </span>
                <div className="text-sm whitespace-pre-wrap">{l.text}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

function Text({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="space-y-0.5">
      <Label>{label}</Label>
      <p className="text-sm whitespace-pre-wrap">{text}</p>
    </div>
  );
}
