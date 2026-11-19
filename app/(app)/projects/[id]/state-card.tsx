'use client';

import { useState, useTransition } from 'react';
import { ArchiveRestore, ArrowUp, Check, Pencil, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { toast } from 'sonner';
import type { ArchivedOut, StateOut } from '@/lib/data/states';
import { restoreLineAction, saveStateAction } from './state-actions';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const icon = 'w-11 h-11 md:w-8 md:h-8 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted active:bg-muted disabled:opacity-40';
const H3 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';

type Op = Record<string, unknown>;

/**
 * The project's State (docs/flows/step-1.md): Now, Next, Later, Decisions. Edits are the same versioned writes the MCP
 * tool makes: Now and reordering carry the version the card was drawn from, so a change a teammate or an agent made in the
 * meantime is never overwritten silently (the card then shows the current State and asks again). Lines someone else wrote
 * say who.
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
  const [editNow, setEditNow] = useState(false);
  const [nowText, setNowText] = useState('');
  const [nextText, setNextText] = useState('');
  const [laterText, setLaterText] = useState('');
  const [decisionText, setDecisionText] = useState('');
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

  const addTo = (op: 'add_next' | 'add_later' | 'add_decision', text: string, clear: () => void) => {
    if (text.trim()) save([{ op, text: text.trim() }], clear);
  };

  return (
    <section className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden" data-card="state" data-state-version={version}>
      <header className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9">
        <h2 className={H3}>State</h2>
        <span className="text-[13px] md:text-xs text-muted-foreground" data-state-version-label>
          {state ? `version ${state.version}` : 'none yet'}
        </span>
      </header>
      <div className="border-t border-border/60 px-4 md:px-3 py-3 space-y-4">
        {!state && (
          <p className="text-sm text-muted-foreground" data-state-empty>
            No State yet. Sessions save Now, Next, Later and Decisions here as they work, so the next session picks up where the last one left off. You can set Now and add lines below too.
          </p>
        )}
        <div className="space-y-1.5" data-part="now">
          <div className="flex items-center gap-1">
            <h3 className={H3}>Now</h3>
            {!editNow && (
              <button type="button" aria-label="Change Now" disabled={pending} onClick={() => (setNowText(state?.now?.text ?? ''), setEditNow(true))} className={icon} data-state-edit-now>
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </div>
          {editNow ? (
            <form
              className="flex gap-2"
              onSubmit={e => {
                e.preventDefault();
                if (nowText.trim()) save([{ op: 'set_now', text: nowText.trim() }], () => setEditNow(false));
              }}
            >
              <input className={field} value={nowText} onChange={e => setNowText(e.target.value)} aria-label="Now" maxLength={1000} autoFocus />
              <button type="submit" disabled={pending} className="h-11 md:h-9 px-4 rounded-full md:rounded-md bg-foreground text-background text-sm font-semibold disabled:opacity-50">
                Save
              </button>
            </form>
          ) : state?.now ? (
            <p className="text-[16px] md:text-sm" data-state-now>
              {state.now.text}
              {state.now.holder && (
                <span className="text-muted-foreground" data-now-holder>
                  {' '}
                  · held by {state.now.holder}
                  {state.now.holderState ? ` (${state.now.holderState})` : ''}
                </span>
              )}
              {state.now.writtenBy && <span className="text-muted-foreground"> · by {state.now.writtenBy}</span>}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing set. One goal for this project, in a line.</p>
          )}
        </div>

        <div className="space-y-1" data-part="next">
          <h3 className={H3}>Next{state?.next.length ? ` · ${state.next.length}` : ''}</h3>
          {state?.next.length ? (
            <ol className="divide-y divide-border/60">
              {state.next.map((l, i) => (
                <li key={l.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-next-id={l.id}>
                  <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 text-[15px] md:text-sm">
                    {l.text}
                    {l.ref && <span className="text-muted-foreground"> #{l.ref}</span>}
                    {l.waitsOn && <span className="text-muted-foreground"> · waits on {l.waitsOn}</span>}
                    {l.holder && <span className="text-muted-foreground" data-line-holder> · {l.holder}</span>}
                    {l.writtenBy && <span className="text-muted-foreground"> · {l.writtenBy}</span>}
                    {l.left && !l.holder && <span className="block text-[13px] md:text-xs text-muted-foreground" data-line-left>{l.left}</span>}
                  </span>
                  {i > 0 && (
                    <button type="button" aria-label={`Move line ${i + 1} up`} disabled={pending} onClick={() => save([{ op: 'move_next', id: l.id, to: i }])} className={icon} data-next-up>
                      <ArrowUp className="w-4 h-4" />
                    </button>
                  )}
                  <button type="button" aria-label={`Done: ${l.text}`} disabled={pending} onClick={() => save([{ op: 'done_next', id: l.id }])} className={icon} data-next-done>
                    <Check className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing queued.</p>
          )}
          <AddLine label="Add to Next" value={nextText} onChange={setNextText} pending={pending} onAdd={() => addTo('add_next', nextText, () => setNextText(''))} data="next" />
        </div>

        <div className="space-y-1" data-part="later">
          <h3 className={H3}>Later{state?.later.length ? ` · ${state.later.length}` : ''}</h3>
          {state?.later.length ? (
            <ul className="divide-y divide-border/60">
              {state.later.map(l => (
                <li key={l.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-later-id={l.id}>
                  <span className="min-w-0 flex-1 text-[15px] md:text-sm">
                    {l.text}
                    {l.waitsOn && <span className="text-muted-foreground"> · waits on {l.waitsOn}</span>}
                    {l.holder && <span className="text-muted-foreground" data-line-holder> · {l.holder}</span>}
                    {l.writtenBy && <span className="text-muted-foreground"> · {l.writtenBy}</span>}
                    {l.left && !l.holder && <span className="block text-[13px] md:text-xs text-muted-foreground" data-line-left>{l.left}</span>}
                  </span>
                  <button type="button" aria-label={`Make a task: ${l.text}`} disabled={pending} onClick={() => save([{ op: 'promote_later', id: l.id }], () => toast.success('Made a task'))} className={icon} data-later-promote>
                    <SquareArrowOutUpRight className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing parked.</p>
          )}
          <AddLine label="Add to Later" value={laterText} onChange={setLaterText} pending={pending} onAdd={() => addTo('add_later', laterText, () => setLaterText(''))} data="later" />
          {archived.length > 0 && (
            <details className="group pt-1" data-part="archived">
              <summary className={`${H3} cursor-pointer min-h-11 md:min-h-9 flex items-center list-none [&::-webkit-details-marker]:hidden`}>Archived lines · {archived.length}</summary>
              <ul className="divide-y divide-border/60">
                {archived.map(a => (
                  <li key={a.id} className="flex items-center gap-1 min-h-11 md:min-h-9" data-archived-id={a.id}>
                    <span className="min-w-0 flex-1 text-[15px] md:text-sm text-muted-foreground">
                      {a.text}
                      {a.waitsOn && <span> · waits on {a.waitsOn}</span>}
                      <span> · from {a.from}, archived {a.archivedAt.slice(0, 10)} by {a.archivedBy}{a.why ? ` (${a.why})` : ''}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Put back: ${a.text}`}
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
                      className={icon}
                      data-archived-restore
                    >
                      <ArchiveRestore className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="space-y-1" data-part="decisions">
          <h3 className={H3}>Decisions{state?.decisions.length ? ` · ${state.decisions.length}` : ''}</h3>
          {state?.decisions.length ? (
            <ul className="space-y-1">
              {state.decisions
                .slice(-5)
                .reverse()
                .map(d => (
                  <li key={d.id} className="text-[15px] md:text-sm">
                    <span className="text-muted-foreground">{d.at.slice(0, 10)} · </span>
                    {d.text}
                    <span className="text-muted-foreground"> · {d.by} ({d.via})</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No decisions recorded.</p>
          )}
          <AddLine label="Record a decision" value={decisionText} onChange={setDecisionText} pending={pending} onAdd={() => addTo('add_decision', decisionText, () => setDecisionText(''))} data="decision" />
        </div>
      </div>
    </section>
  );
}

function AddLine({ label, value, onChange, onAdd, pending, data }: { label: string; value: string; onChange: (v: string) => void; onAdd: () => void; pending: boolean; data: string }) {
  return (
    <form
      className="flex gap-2 pt-1"
      onSubmit={e => {
        e.preventDefault();
        onAdd();
      }}
    >
      <input className={field} value={value} onChange={e => onChange(e.target.value)} placeholder={label} aria-label={label} maxLength={500} data-state-add={data} />
      <button type="submit" disabled={pending || !value.trim()} aria-label={`${label}: add`} className="w-11 h-11 md:w-9 md:h-9 shrink-0 inline-flex items-center justify-center rounded-full md:rounded-md border border-input text-foreground disabled:opacity-40" data-state-add-button={data}>
        <Plus className="w-4 h-4" />
      </button>
    </form>
  );
}
