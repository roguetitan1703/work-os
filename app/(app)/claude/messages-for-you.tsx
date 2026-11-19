'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { MessageForYou } from '@/lib/data/messages';
import { write } from './auto-refresh';
import { makeTaskFromMessageAction, messageStatusAction, replyToMessageAction } from './message-actions';
import { btnOutline, field, H2 } from './ui';

const FIRST = 5;
const WHO: Record<string, string> = { person: 'in the app', chat: 'through Claude chat', agent: 'through a Claude session' };

/** Messages a person sent to you (a session of someone else's, or a teammate): apply, reject or reply here. Messages between your own sessions never show. */
export function MessagesForYou({ items, onDone }: { items: MessageForYou[]; onDone: (m: MessageForYou) => void }) {
  const [open, setOpen] = useState<string | null>(null); // one expanded at a time
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, FIRST);
  return (
    <section className="space-y-1" data-section="messages-for-you">
      <h2 className={cn(H2, 'px-1 md:px-0 text-amber-700 dark:text-amber-300')}>Messages for you {items.length}</h2>
      <ul className="rounded-xl border border-amber-500/30 bg-amber-500/5 divide-y divide-amber-500/20 overflow-hidden">
        {list.map(m => (
          <Row key={m.id} m={m} expanded={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} onDone={() => onDone(m)} />
        ))}
        {items.length > FIRST && (
          <li>
            <button type="button" onClick={() => setAll(v => !v)} className="w-full text-left px-3 h-11 md:h-8 text-[13px] font-medium text-muted-foreground hover:bg-amber-500/10" data-messages-more>
              {all ? 'Show fewer' : `${items.length - FIRST} more`}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function Row({ m, expanded, onToggle, onDone }: { m: MessageForYou; expanded: boolean; onToggle: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const typed = text.trim();
  const line = m.body.split('\n')[0];
  const first = line.length > 140 ? `${line.slice(0, 139)}…` : line; // the closed row is one short line; the text is in full when it is open

  // Plain flag, not useTransition (as the Needs rows above: a transition stayed pending after the revalidation).
  const go = async (fn: () => Promise<{ ok: boolean; error?: string; task?: string }>, done: string, closes = true) => {
    setBusy(true);
    try {
      const r = await write(fn);
      if (!r.ok) return void toast.error(r.error ?? 'Could not do that');
      toast(r.task ? `${done}: ${r.task}` : done);
      setText('');
      if (closes) onDone(); // a reply leaves the message where it is: it is still open until you apply or reject it
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-message-for-you={m.id} data-msg-kind={m.kind} data-msg-word={m.word}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full flex items-start gap-2 px-3 min-h-11 md:min-h-8 text-left hover:bg-amber-500/10 active:bg-amber-500/15">
        {expanded ? <ChevronDown className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 mt-3.5 md:mt-2.5 shrink-0 text-muted-foreground" />}
        <span className="text-[16px] md:text-[13px] min-w-0 py-2 md:py-1.5 break-words">
          <span className="font-semibold">{m.from.name}</span>
          <span className="text-muted-foreground">
            {m.project ? ` · ${m.project}` : ''} · {m.kind} ·{' '}
          </span>
          <span className="text-foreground">{expanded ? '' : first}</span>
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <p className="text-[13px] md:text-xs text-muted-foreground" data-msg-via>
            {WHO[m.word] ?? m.word}
            {m.from.label ? `: ${m.from.label}` : ''}, <span suppressHydrationWarning>{new Date(m.at).toLocaleString()}</span>
          </p>
          <p className="text-[16px] md:text-sm whitespace-pre-wrap break-words" data-msg-body>
            {m.body}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnOutline} disabled={busy} data-msg-apply onClick={() => go(() => messageStatusAction(m.id, 'applied'), m.kind === 'decision' ? 'Applied, added to Decisions' : 'Applied')}>
              Apply
            </button>
            <button type="button" className={btnOutline} disabled={busy} data-msg-reject onClick={() => go(() => messageStatusAction(m.id, 'rejected'), 'Rejected')}>
              Reject
            </button>
            {m.kind === 'request' && m.projectId && (
              <button type="button" className="h-11 md:h-auto px-2 text-[13px] md:text-xs text-muted-foreground underline shrink-0 disabled:opacity-50" disabled={busy} data-msg-task onClick={() => go(() => makeTaskFromMessageAction(m.id), 'Made a task')}>
                Make a task
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              className={cn(field, 'flex-1')}
              value={text}
              maxLength={4000}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && typed && !busy && void go(() => replyToMessageAction(m.id, typed), 'Reply sent', false)}
              placeholder="Reply…"
              aria-label={`Reply to ${m.from.name}`}
              enterKeyHint="send"
              data-msg-reply-input
            />
            <button type="button" className={cn(btnOutline, 'bg-foreground text-background border-foreground hover:bg-foreground/90')} disabled={busy || !typed} data-msg-reply onClick={() => go(() => replyToMessageAction(m.id, typed), 'Reply sent', false)}>
              Reply
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
