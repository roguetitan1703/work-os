'use client';

import { useState, useTransition } from 'react';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { BottomSheet } from '@/components/mobile/sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { saveStateAction } from '@/app/(app)/projects/[id]/state-actions';
import type { StateOut } from '@/lib/data/states';

const H2 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';
const CARD = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden';
const icon = 'w-11 h-11 md:w-8 md:h-8 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted active:bg-muted disabled:opacity-40';
const field =
  'w-full min-w-0 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 py-2 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * The project's purpose, on every tab: Now (clamped to two lines, tap to read it all), who holds it and the first Next line.
 * With no Now it shows the project's description and a Set Now button. The Now edit is the State card's save (the same
 * versioned write: a change made elsewhere meanwhile is refused and the current State shown), so base_version and the hold
 * rules are the ones the State uses.
 */
export function PurposeHeader({ projectId, initial, description }: { projectId: string; initial: StateOut | null; description?: string }) {
  const phone = usePhone();
  const [state, setState] = useState<StateOut | null>(initial);
  const [seen, setSeen] = useState(initial?.version ?? -1);
  if ((initial?.version ?? -1) !== seen) {
    setSeen(initial?.version ?? -1);
    setState(initial);
  }
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const now = state?.now ?? null;
  const next = state?.next[0]?.text;

  const edit = () => {
    setText(now?.text ?? '');
    setOpen(false);
    setEditing(true);
  };
  const save = () => {
    if (!text.trim()) return;
    start(async () => {
      const r = await saveStateAction(projectId, [{ op: 'set_now', text: text.trim() }], state?.version ?? 0);
      if (r.ok) {
        setState(r.state);
        setEditing(false);
        return;
      }
      if (r.state) setState(r.state);
      toast.error(r.error);
    });
  };

  const sub = [now?.holder ? `held by ${now.holder}` : '', next ? `Next: ${next}` : ''].filter(Boolean);

  return (
    <section className={`${CARD} px-4 md:px-3 pb-3 md:pb-2.5`} data-card="purpose" data-state-version={state?.version ?? 0}>
      <div className="flex items-center gap-1 min-h-11 md:min-h-9">
        <h2 className={H2}>Now</h2>
        <span className="ml-auto -mr-2.5 md:-mr-1.5 flex items-center">
          {!editing && now && (
            <button type="button" aria-label="Change Now" disabled={pending} onClick={edit} className={icon} data-state-edit-now>
              <Pencil className="w-4 h-4" />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={e => {
            e.preventDefault();
            save();
          }}
        >
          <textarea className={field} rows={4} value={text} onChange={e => setText(e.target.value)} aria-label="Now" maxLength={1000} autoFocus />
          <div className="flex gap-2">
            <button type="submit" disabled={pending || !text.trim()} className="h-11 md:h-9 px-4 rounded-full md:rounded-md bg-foreground text-background text-sm font-semibold disabled:opacity-50">
              Save
            </button>
            <button type="button" disabled={pending} onClick={() => setEditing(false)} className="h-11 md:h-9 px-4 rounded-full md:rounded-md border border-input text-sm font-medium disabled:opacity-50">
              Cancel
            </button>
          </div>
        </form>
      ) : now ? (
        <>
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="block w-full text-left min-w-0" data-purpose-toggle>
            <p className={`text-[15px] md:text-[17px] leading-snug break-words ${open && !phone ? '' : 'line-clamp-2'}`} data-state-now data-purpose-text>
              {now.text}
            </p>
          </button>
          {(sub.length > 0 || now.writtenBy) && (
            <p className="mt-1 text-[13px] md:text-xs text-muted-foreground truncate" data-purpose-sub>
              {now.writtenBy && <span data-now-writer>by {now.writtenBy}{sub.length ? ' · ' : ''}</span>}
              {now.holder && (
                <span data-now-holder>
                  held by {now.holder}
                  {now.holderState ? ` (${now.holderState})` : ''}
                  {next ? ' · ' : ''}
                </span>
              )}
              {next && <span data-purpose-next>Next: {next}</span>}
            </p>
          )}
          {open && phone && (
            <BottomSheet title="Now" onClose={() => setOpen(false)}>
              <p className="text-[16px] leading-snug whitespace-pre-wrap break-words pb-3" data-purpose-full>
                {now.text}
              </p>
              {now.writtenBy && <p className="text-[13px] text-muted-foreground pb-2">by {now.writtenBy}</p>}
              <button type="button" onClick={edit} className="h-11 w-full rounded-full border border-input text-sm font-medium mb-2">
                Change Now
              </button>
            </BottomSheet>
          )}
        </>
      ) : (
        <div className="space-y-2" data-purpose-empty>
          {description ? <p className="text-[15px] md:text-sm text-muted-foreground line-clamp-2 break-words" data-purpose-description>{description}</p> : <p className="text-[15px] md:text-sm text-muted-foreground">No goal set yet. One goal for this project, in a line.</p>}
          {next && <p className="text-[13px] md:text-xs text-muted-foreground truncate" data-purpose-next>Next: {next}</p>}
          <button type="button" onClick={edit} disabled={pending} className="h-11 md:h-8 px-4 md:px-3 inline-flex items-center rounded-full md:rounded-md border border-input text-sm md:text-xs font-medium disabled:opacity-50" data-state-set-now>
            Set Now
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The task's why, under its title on both task screens: one line (clamped to two) and, in smaller type, the project's Now.
 * Read-only: the project's header is where Now is changed.
 */
export function TaskPurposeHeader({ purpose }: { purpose: { why: { kind: string; text: string } | null; now: string | null; projectId: string | null } }) {
  if (!purpose.why && !purpose.now) return null;
  return (
    <section className={`${CARD} px-4 md:px-3 py-3 md:py-2.5 space-y-1`} data-card="task-purpose">
      {purpose.why && (
        <p className="text-[15px] md:text-sm leading-snug break-words line-clamp-2" data-task-why={purpose.why.kind}>
          {purpose.why.text}
        </p>
      )}
      {purpose.now && (
        <p className="text-[13px] md:text-xs text-muted-foreground line-clamp-2 break-words" data-task-project-now>
          Project Now: {purpose.now}
        </p>
      )}
    </section>
  );
}
