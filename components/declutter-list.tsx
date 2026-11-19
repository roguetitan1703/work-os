'use client';

import { Check, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { DeclutterItem, DeclutterKind } from '@/lib/declutter-core';

// The changes of one Declutter, as rows with a checkbox each: on the Need card and in the project's Declutter dialog. Grouped
// by kind. Text the session added (add_later, add_task) and the disk lines are the agent's own words, labelled so.

const GROUPS: { kinds: DeclutterKind[]; title: string }[] = [
  { kinds: ['archive_line', 'done_next'], title: 'State lines' },
  { kinds: ['archive_note'], title: 'Pages' },
  { kinds: ['complete_task'], title: 'Tasks to finish' },
  { kinds: ['withdraw_need'], title: 'Old Needs to withdraw' },
  { kinds: ['add_later', 'add_task'], title: 'Added by the session (written by the agent, not checked)' },
];

const VERB: Record<DeclutterKind, string> = {
  archive_line: 'Archive',
  done_next: 'Mark done',
  archive_note: 'Archive page',
  complete_task: 'Finish',
  withdraw_need: 'Withdraw',
  add_later: 'Add to Later',
  add_task: 'Add task',
};

export type DeclutterResult = { applied: string[]; failed: string[] };

/**
 * `ticked` is the set of item ids that will be applied; `onToggle` makes the boxes live (omit it for a read-only list). With
 * `result` the boxes give way to what happened: each row says applied or failed, and failed rows say why.
 */
export function DeclutterList({ items, ticked, onToggle, result, phone, testid = 'declutter-list' }: { items: DeclutterItem[]; ticked?: Set<string>; onToggle?: (id: string) => void; result?: DeclutterResult; phone: boolean; testid?: string }) {
  const failed = new Map((result?.failed ?? []).map(f => [f.split(': ')[0], f.slice(f.indexOf(': ') + 2)]));
  const applied = new Set(result?.applied ?? []);
  return (
    <div className="space-y-3" data-declutter-list={testid}>
      {GROUPS.map(g => {
        const rows = items.filter(i => g.kinds.includes(i.kind));
        if (!rows.length) return null;
        return (
          <section key={g.title} className="space-y-1" data-declutter-group={g.kinds[0]}>
            <h4 className={cn('font-semibold text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>{g.title} · {rows.length}</h4>
            <ul className="divide-y divide-border/60">
              {rows.map(i => {
                const bad = failed.get(i.id);
                const done = !!result && applied.has(i.id);
                const left = !!result && !done && !bad; // unticked
                return (
                  <li key={i.id} className={cn('flex items-start gap-2 py-2', phone ? 'min-h-11' : 'min-h-9')} data-declutter-item={i.id} data-declutter-state={bad ? 'failed' : done ? 'applied' : left ? 'left' : ticked?.has(i.id) ? 'ticked' : 'unticked'}>
                    {result ? (
                      <span className={cn('mt-0.5 w-4 h-4 shrink-0 inline-flex items-center justify-center', bad ? 'text-destructive' : 'text-muted-foreground')} aria-hidden>
                        {bad ? <X className="w-4 h-4" /> : done ? <Check className="w-4 h-4" /> : null}
                      </span>
                    ) : (
                      <Checkbox className="mt-0.5" checked={ticked?.has(i.id) ?? true} disabled={!onToggle} onCheckedChange={() => onToggle?.(i.id)} aria-label={`${VERB[i.kind]}: ${i.text}`} data-declutter-box={i.id} />
                    )}
                    <span className={cn('min-w-0 flex-1 break-words', phone ? 'text-[15px]' : 'text-sm', left && 'text-muted-foreground')}>
                      <span className="text-muted-foreground">{VERB[i.kind]}: </span>
                      {i.text}
                      <span className={cn('block text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>{bad ? `Not applied: ${bad}` : left ? 'Left out (unticked)' : i.why}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** What the session says it will do on disk after a Yes: shown, never run by Work OS. */
export function DiskLines({ lines, phone }: { lines: string[]; phone: boolean }) {
  if (!lines.length) return null;
  return (
    <div className={cn('rounded-lg bg-muted/50 px-3 py-2 space-y-1 break-words', phone ? 'text-[14px]' : 'text-xs')} data-declutter-disk>
      <p className="italic text-muted-foreground">The session will also do (written by the agent, not checked; Work OS does not do these):</p>
      <ul className="list-disc pl-5">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
