'use client';

import { useState, useTransition } from 'react';
import { ArchiveRestore, ArrowUp, Check, ChevronDown, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip, ChipGroup } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import type { ArchivedOut, StateOut } from '@/lib/data/states';
import { restoreLineAction, saveStateAction } from './state-actions';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-control border border-input bg-background dark:bg-input/30 px-3 text-base md:text-meta text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const H3 = 'text-meta font-medium text-muted-foreground';
const fold = 'group border-t border-border/60';
const summary = 'flex items-center gap-2 px-4 min-h-11 md:min-h-9 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-muted/60';

type Op = Record<string, unknown>;
type Kind = 'next' | 'later' | 'decision';
const KINDS: { id: Kind; label: string; op: 'add_next' | 'add_later' | 'add_decision'; hint: string }[] = [
  { id: 'next', label: 'Next', op: 'add_next', hint: 'Add to Next' },
  { id: 'later', label: 'Later', op: 'add_later', hint: 'Add to Later' },
  { id: 'decision', label: 'Decision', op: 'add_decision', hint: 'Record a decision' },
];

/** Next lines shown before "Show all". */
const NEXT_SHOWN = 3;

/**
 * The project's State (docs/flows/step-1.md), folded: the first three Next lines, Later and Decisions as counts that open,
 * and one Add control (Next, Later or a decision). Now is the purpose header's (components/purpose-header.tsx). Edits are
 * the same versioned writes the MCP tool makes: Now and reordering carry the version the card was drawn from, so a change a
 * teammate or an agent made in the meantime is never overwritten silently (the card then shows the current State and asks
 * again). Lines someone else wrote say who.
 */
export function StateCard({ projectId, initial, archived: archivedInitial = [] }: { projectId: string; initial: StateOut | null; archived?: ArchivedOut[] }) {
  // The page's State follows the server: a new version (a teammate's or an agent's save, or ours coming back) replaces the local copy.
  const [state, setState] = useState<StateOut | null>(initial);
  const [archived, setArchived] = useState<ArchivedOut[]>(archivedInitial);
  const [seen, setSeen] = useState(initial?.version ?? -1);
  if ((initial?.version ?? -1) !== seen) {
    setSeen(initial?.version ?? -1);
    setState(initial);
    setArchived(archivedInitial);
  }
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<Kind>('next');
  const [text, setText] = useState('');
  const [allNext, setAllNext] = useState(false);
  const version = state?.version ?? 0;

  const save = (ops: Op[], after?: () => void) =>
    start(async () => {
      const r = await saveStateAction(projectId, ops, version);
      if (r.ok) {
        setState(r.state);
        after?.();
        return;
      }
      if (r.state) setState(r.state);
      toast.error(r.error);
    });

  const k = KINDS.find(x => x.id === kind)!;
  const add = () => {
    if (!text.trim()) return;
    save([{ op: k.op, text: text.trim() }], () => {
      setText('');
      // Show what was added: the whole Next list, or say where it went (Later and Decisions stay folded).
      if (kind === 'next') setAllNext(true);
      else toast.success(kind === 'later' ? 'Added to Later' : 'Decision recorded');
    });
  };
  const next = state?.next ?? [];
  const shownNext = allNext ? next : next.slice(0, NEXT_SHOWN);

  return (
    <Card as="section" data-card="state" data-state-version={version}>
      <header className="flex items-center gap-2 pl-4 pr-2 min-h-11 md:min-h-9">
        <h2 className={H3}>State</h2>
        <span className="text-meta text-muted-foreground/70" data-state-version-label>
          {state ? `version ${state.version}` : 'none yet'}
        </span>
        <Button variant="ghost" size="touch" className="ml-auto px-3 text-muted-foreground" aria-expanded={adding} onClick={() => setAdding(a => !a)} data-state-add-open>
          <Plus /> Add
        </Button>
      </header>
      {adding && (
        <form
          className="border-t border-border/60 px-4 py-3 space-y-2"
          onSubmit={e => {
            e.preventDefault();
            add();
          }}
          data-state-add-form
        >
          <ChipGroup label="Add to">
            {KINDS.map(x => (
              <Chip key={x.id} selected={kind === x.id} onClick={() => setKind(x.id)} data-state-add-kind={x.id}>
                {x.label}
              </Chip>
            ))}
          </ChipGroup>
          <div className="flex gap-2">
            <input className={field} value={text} onChange={e => setText(e.target.value)} placeholder={k.hint} aria-label={k.hint} maxLength={500} data-state-add={kind} autoFocus />
            <IconButton type="submit" variant="outline" label={`${k.hint}: add`} disabled={pending || !text.trim()} data-state-add-button={kind}>
              <Plus />
            </IconButton>
          </div>
        </form>
      )}
      {!state && (
        <p className="border-t border-border/60 px-4 py-3 text-meta text-muted-foreground" data-state-empty>
          No State yet. Sessions save Now, Next, Later and Decisions here as they work, so the next session picks up where the last one left off. You can set Now above and add lines here too.
        </p>
      )}

      <div className="border-t border-border/60 px-4 py-2 space-y-1" data-part="next">
        <h3 className={H3}>Next{next.length ? ` · ${next.length}` : ''}</h3>
        {next.length ? (
          <ol className="divide-y divide-border/60">
            {shownNext.map((l, i) => (
              <li key={l.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-next-id={l.id}>
                <span className="w-5 shrink-0 text-label text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 text-body md:text-meta">
                  {l.text}
                  {l.ref && <span className="text-muted-foreground"> #{l.ref}</span>}
                  {l.waitsOn && <span className="text-muted-foreground"> · waits on {l.waitsOn}</span>}
                  {l.holder && <span className="text-muted-foreground" data-line-holder> · {l.holder}</span>}
                  {l.writtenBy && <span className="text-muted-foreground"> · {l.writtenBy}</span>}
                  {l.left && !l.holder && <span className="block text-meta text-muted-foreground" data-line-left>{l.left}</span>}
                </span>
                {i > 0 && (
                  <IconButton label={`Move line ${i + 1} up`} disabled={pending} onClick={() => save([{ op: 'move_next', id: l.id, to: i }])} data-next-up>
                    <ArrowUp />
                  </IconButton>
                )}
                <IconButton label={`Done: ${l.text}`} disabled={pending} onClick={() => save([{ op: 'done_next', id: l.id }])} data-next-done>
                  <Check />
                </IconButton>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-meta text-muted-foreground py-1">Nothing queued.</p>
        )}
        {next.length > NEXT_SHOWN && (
          <Button variant="ghost" size="touch" className="-ml-3 px-3 text-muted-foreground" onClick={() => setAllNext(a => !a)} data-next-all>
            {allNext ? 'Show the first three' : `Show all ${next.length}`}
          </Button>
        )}
      </div>

      <details className={fold} data-part="later">
        <summary className={summary}>
          <h3 className={H3}>Later · {state?.later.length ?? 0}</h3>
          <ChevronDown className="ml-auto w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="px-4 pb-2">
          {state?.later.length ? (
            <ul className="divide-y divide-border/60">
              {state.later.map(l => (
                <li key={l.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-later-id={l.id}>
                  <span className="min-w-0 flex-1 text-body md:text-meta">
                    {l.text}
                    {l.waitsOn && <span className="text-muted-foreground"> · waits on {l.waitsOn}</span>}
                    {l.holder && <span className="text-muted-foreground" data-line-holder> · {l.holder}</span>}
                    {l.writtenBy && <span className="text-muted-foreground"> · {l.writtenBy}</span>}
                    {l.left && !l.holder && <span className="block text-meta text-muted-foreground" data-line-left>{l.left}</span>}
                  </span>
                  <IconButton label={`Make a task: ${l.text}`} disabled={pending} onClick={() => save([{ op: 'promote_later', id: l.id }], () => toast.success('Made a task'))} data-later-promote>
                    <SquareArrowOutUpRight />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground py-1">Nothing parked.</p>
          )}
          {archived.length > 0 && (
            <details className="group/arch pt-1" data-part="archived">
              <summary className={`${H3} cursor-pointer min-h-11 md:min-h-9 flex items-center list-none [&::-webkit-details-marker]:hidden`}>Archived lines · {archived.length}</summary>
              <ul className="divide-y divide-border/60">
                {archived.map(a => (
                  <li key={a.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-archived-id={a.id}>
                    <span className="min-w-0 flex-1 text-body md:text-meta text-muted-foreground">
                      {a.text}
                      {a.waitsOn && <span> · waits on {a.waitsOn}</span>}
                      <span> · from {a.from}, archived {a.archivedAt.slice(0, 10)} by {a.archivedBy}{a.why ? ` (${a.why})` : ''}</span>
                    </span>
                    <IconButton
                      label={`Put back: ${a.text}`}
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const r = await restoreLineAction(projectId, a.id);
                          if (!r.ok) return void toast.error(r.error);
                          setState(r.state);
                          setArchived(r.archived);
                          setSeen(r.state.version);
                          toast.success('Put back in Later');
                        })
                      }
                      data-archived-restore
                    >
                      <ArchiveRestore />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </details>

      <details className={fold} data-part="decisions">
        <summary className={summary}>
          <h3 className={H3}>Decisions · {state?.decisions.length ?? 0}</h3>
          <ChevronDown className="ml-auto w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="px-4 pb-3">
          {state?.decisions.length ? (
            <ul className="space-y-1">
              {state.decisions
                .slice(-5)
                .reverse()
                .map(d => (
                  <li key={d.id} className="text-body md:text-meta">
                    <span className="text-muted-foreground">{d.at.slice(0, 10)} · </span>
                    {d.text}
                    <span className="text-muted-foreground"> · {d.by} ({d.via})</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-meta text-muted-foreground py-1">No decisions recorded.</p>
          )}
        </div>
      </details>
    </Card>
  );
}
