'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { MessageOut } from '@/lib/data/messages';
import { Select } from '@/components/ui/select';
import { makeTaskFromMessageAction, messageStatusAction, sendMessageAction } from './inbox-actions';

const field =
  'w-full min-w-0 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const btn = 'inline-flex items-center justify-center h-11 md:h-8 px-3 rounded-xl md:rounded-md text-sm md:text-xs font-medium border border-input hover:bg-muted active:bg-muted disabled:opacity-40';

const WORDS: Record<string, string> = { person: 'person', chat: 'Claude chat', agent: 'an agent' };

/**
 * The project's messages (docs/flows/step-1.md section 4), grouped in threads. Anyone who reads the project reads them.
 * A person sends, applies or rejects here (applying a decision adds it to the State's Decisions), and turns a request into a task.
 */
export function InboxTab({ projectId, messages }: { projectId: string; messages: MessageOut[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState('fyi');
  const [body, setBody] = useState('');
  const [toSession, setToSession] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const threads = new Map<string, MessageOut[]>();
  for (const m of [...messages].sort((a, b) => a.at.localeCompare(b.at))) threads.set(m.thread, [...(threads.get(m.thread) ?? []), m]);
  const ordered = [...threads.values()].sort((a, b) => b[b.length - 1].at.localeCompare(a[a.length - 1].at));

  const done = (r: { ok: boolean; error?: string; target?: string; task?: string }, ok: string) => {
    if (!r.ok) return void toast.error(r.error ?? 'Could not do that');
    toast.success(r.task ? `${ok}: ${r.task}` : r.target ? `${ok}. ${r.target}` : ok);
    router.refresh();
  };

  return (
    <section className="space-y-4 max-w-3xl" data-view="inbox">
      <form
        className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card p-3 space-y-2"
        data-inbox-form
        onSubmit={e => {
          e.preventDefault();
          if (!body.trim()) return;
          start(async () => {
            const r = await sendMessageAction(projectId, kind, body.trim(), toSession);
            if (r.ok) {
              setBody('');
              setToSession('');
            }
            done(r, 'Sent');
          });
        }}
      >
        <div className="flex flex-col md:flex-row gap-2">
          <Select aria-label="Kind" value={kind} onChange={e => setKind(e.target.value)} className={`${field} h-11 md:h-9 md:w-[11.5rem] md:shrink-0`} data-inbox-kind>
            <option value="fyi">For your information</option>
            <option value="request">Request</option>
            <option value="decision">Decision</option>
            <option value="question">Question</option>
          </Select>
          <input value={toSession} onChange={e => setToSession(e.target.value)} placeholder="For session (optional)" aria-label="For session" className={`${field} h-11 md:h-9`} maxLength={120} data-inbox-to />
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Message to the project’s sessions" aria-label="Message" rows={3} maxLength={4000} className={`${field} py-2`} data-inbox-body />
        <div className="flex justify-end">
          <button type="submit" disabled={pending || !body.trim()} className={btn} data-inbox-send>
            Send
          </button>
        </div>
      </form>

      {ordered.length === 0 && <p className="text-sm text-muted-foreground px-1">No messages yet. Agents and teammates leave decisions, requests and questions here.</p>}

      {ordered.map(thread => (
        <div key={thread[0].thread} className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card divide-y divide-border/60 overflow-hidden" data-thread={thread[0].thread}>
          {thread.map(m => {
            const open = m.status === 'unread' || m.status === 'seen';
            return (
              <article key={m.id} className="px-4 md:px-3 py-3 md:py-2 space-y-1.5" data-msg-id={m.id} data-msg-status={m.status} data-msg-kind={m.kind} data-msg-word={m.word}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] md:text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{m.from.name === 'me' ? 'Me' : m.from.name}</span>
                  <span>
                    via {WORDS[m.word] ?? m.word}
                    {m.from.ai ? ` (${m.from.ai}${m.from.label ? `, ${m.from.label}` : ''})` : ''}
                  </span>
                  <span className="uppercase tracking-wider">{m.kind}</span>
                  <span suppressHydrationWarning>{new Date(m.at).toLocaleString()}</span>
                  <span className="ml-auto rounded bg-muted px-1.5 py-px" data-msg-status-label>
                    {m.status}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words" data-msg-body>
                  {m.body}
                </p>
                {(m.note || m.commit || m.taskRef || m.toSession) && (
                  <p className="text-[13px] md:text-xs text-muted-foreground">
                    {m.toSession ? `For ${m.toSession}. ` : ''}
                    {m.commit ? `Commit ${m.commit}. ` : ''}
                    {m.note ?? ''}
                  </p>
                )}
                {open && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input
                      value={notes[m.id] ?? ''}
                      onChange={e => setNotes({ ...notes, [m.id]: e.target.value })}
                      placeholder="Note (optional)"
                      aria-label="Note"
                      className={`${field} h-11 md:h-8 flex-1 min-w-32`}
                      maxLength={500}
                    />
                    <button type="button" disabled={pending} className={btn} data-msg-apply onClick={() => start(async () => done(await messageStatusAction(projectId, m.id, 'applied', notes[m.id]), m.kind === 'decision' ? 'Applied, added to Decisions' : 'Applied'))}>
                      Apply
                    </button>
                    <button type="button" disabled={pending} className={btn} data-msg-reject onClick={() => start(async () => done(await messageStatusAction(projectId, m.id, 'rejected', notes[m.id]), 'Rejected'))}>
                      Reject
                    </button>
                    {m.kind === 'request' && (
                      <button type="button" disabled={pending} className={btn} data-msg-task onClick={() => start(async () => done(await makeTaskFromMessageAction(projectId, m.id), 'Made a task'))}>
                        Make a task
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ))}
    </section>
  );
}
