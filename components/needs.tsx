'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { HandHelping } from 'lucide-react';
import Link from '@/components/intent-link';
import { answerNeedAction } from '@/app/(app)/needs/actions';
import { actorLabel } from '@/lib/actors';
import { Ago } from './ago';
import type { Need } from '@/lib/data/needs';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';
import { usePhone } from './mobile/use-phone';
import { MEmpty } from './mobile/sub-header';

const KIND_LABEL: Record<Need['kind'], string> = { decide: 'Decide', approve: 'Approve', review: 'Review', do: 'Do', chase: 'Chase' };

/** One Need: who asked, the ask, an example, the options as buttons and a text box. Answerable only by the person it is addressed to. */
export function NeedCard({ need, phone, canAnswer = true, onAnswered }: { need: Need; phone: boolean; canAnswer?: boolean; onAnswered?: (id: string) => void }) {
  const { people, me, projectName } = useApp();
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const open = need.status === 'open';
  const asker = actorLabel(need.from.actor, me, people);
  const project = projectName(need.projectId);

  function answer(option: string) {
    start(async () => {
      const r = await answerNeedAction(need.id, option, text.trim() || undefined);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Need #${need.ref} answered`);
      onAnswered?.(need.id);
    });
  }

  return (
    <article
      data-need={need.ref}
      data-need-status={need.status}
      className={cn('rounded-xl border bg-card', phone ? 'border-border/70 p-4 space-y-3' : 'border-border p-3 space-y-2', !open && 'opacity-75')}
    >
      <div className={cn('flex items-center gap-1.5 flex-wrap text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>
        <HandHelping className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <span className="font-mono">Need #{need.ref}</span>
        <span>· {KIND_LABEL[need.kind]}</span>
        {project && <Link href={`/projects/${need.projectId}?tab=needs`} className="truncate max-w-[40vw] hover:text-foreground">· {project}</Link>}
        {need.taskRef && <Link href={`/tasks/${need.taskRef}`} className="hover:text-foreground">· on #{need.taskRef}</Link>}
        <span className="ml-auto"><Ago iso={need.createdAt} /></span>
      </div>
      <p className={cn('text-foreground leading-snug whitespace-pre-wrap break-words', phone ? 'text-[16px]' : 'text-sm')} data-need-ask>
        {need.ask}
      </p>
      <p className={cn('text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')} data-need-from>
        Asked by {asker}, {need.from.word === 'person' ? 'in the app' : need.from.word === 'chat' ? 'through chat' : 'by an agent'}
        {need.from.label ? <span className="italic opacity-80" title="Typed by the agent, not checked"> (“{need.from.label}”)</span> : null}
        {need.appOnly ? ' · answer in the app only' : ''}
      </p>
      {need.result && (
        <div data-need-result className={cn('rounded-lg bg-muted/50 px-3 py-2 space-y-1 break-words', phone ? 'text-[14px]' : 'text-xs')}>
          <p className="italic text-muted-foreground">Written by the agent, not checked.</p>
          <p><span className="font-medium">Changed:</span> {need.result.changed}</p>
          {need.result.checked && <p><span className="font-medium">Checked:</span> {need.result.checked}</p>}
          {need.result.rating && <p><span className="font-medium">Their verdict:</span> {need.result.rating}</p>}
          {need.result.where.length > 0 && (
            <p>
              <span className="font-medium">Where:</span>{' '}
              {need.result.where.map((w, i) => (
                <a key={i} href={w.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 mr-2 break-all">
                  {w.label ? `${w.label} (${hostOf(w.url)})` : w.url}
                </a>
              ))}
            </p>
          )}
          {need.result.left.length > 0 && (
            <div>
              <span className="font-medium">Left:</span>
              <ul className="list-disc pl-5">
                {need.result.left.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {need.example && <p className={cn('rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground whitespace-pre-wrap break-words', phone ? 'text-[14px]' : 'text-xs')}>For example: {need.example}</p>}
      {open && canAnswer && (
        <>
          <div className={cn('flex flex-wrap gap-2', phone && 'flex-col')}>
            {need.options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                disabled={pending || (need.kind === 'review' && o.id === 'send_back' && !text.trim())}
                data-need-option={o.id}
                title={o.means}
                onClick={() => answer(o.id)}
                className={cn(
                  'rounded-lg border text-left transition-colors disabled:opacity-60',
                  phone ? 'min-h-11 px-4 py-2 text-[15px]' : 'px-3 py-1.5 text-sm',
                  i === 0 ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted',
                )}
              >
                <span className="font-medium">{o.label}</span>
                {i === 0 && need.kind === 'decide' && <span className="ml-1.5 text-[11px] opacity-80">recommended</span>}
                {o.means && <span className={cn('block font-normal opacity-80', phone ? 'text-[13px]' : 'text-[11px]')}>{o.means}</span>}
              </button>
            ))}
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && need.kind !== 'review' && text.trim() && !pending) {
                e.preventDefault();
                answer('other');
              }
            }}
            maxLength={1000}
            rows={2}
            data-need-text
            placeholder={need.kind === 'review' ? 'To send it back: what should change? This line comes first in its next brief.' : 'Or type your own answer (also sent as a note with a button)'}
            aria-label={`Note for Need #${need.ref}`}
            className={cn('w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40', phone ? 'text-[16px]' : 'text-sm')}
          />
          {need.kind !== 'review' && text.trim() && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={pending}
                data-need-send
                onClick={() => answer('other')}
                className={cn(
                  'rounded-lg border border-border bg-background hover:bg-muted transition-colors disabled:opacity-60 font-medium',
                  phone ? 'min-h-11 w-full px-4 py-2 text-[15px]' : 'px-3 py-1.5 text-sm',
                )}
              >
                Send my answer
              </button>
            </div>
          )}
        </>
      )}
      {open && !canAnswer && (
        <p className={cn('text-muted-foreground', phone ? 'text-[14px]' : 'text-xs')} data-need-waiting>
          Waiting on {people[need.to] ?? 'someone'}
        </p>
      )}
      {!open && (
        <p className={cn('text-muted-foreground', phone ? 'text-[14px]' : 'text-xs')} data-need-closed>
          {need.status === 'answered' && need.answer
            ? `Answered${need.answer.option ? ': ' + (need.options.find(o => o.id === need.answer!.option)?.label ?? (need.answer.option === 'other' ? 'own answer' : need.answer.option)) : ''}${need.filed?.length ? ` · filed ${need.filed.map(r => '#' + r).join(', ')}` : ''}${need.answer.text ? ` · "${need.answer.text}"` : ''}${need.waitedMs !== null ? ` · waited ${fmtWait(need.waitedMs)}` : ''}`
            : need.status === 'withdrawn'
              ? 'Withdrawn by the asker'
              : 'Replaced by a newer ask'}
          {need.status === 'answered' && need.releaseUntil && (
            <ReleaseWindow iso={need.releaseUntil} />
          )}
        </p>
      )}
    </article>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** How long a release Need's window runs: "Release open until 15:20" while it is open, "Release ended" after. */
function ReleaseWindow({ iso }: { iso: string }) {
  const [now] = useState(() => Date.now());
  return (
    <span data-need-release suppressHydrationWarning>
      {' · '}
      {Date.parse(iso) > now ? `Release open until ${untilLabel(iso)}` : 'Release ended'}
    </span>
  );
}

/** "15:20", or "Fri 15:20" when it is not today: when a release window ends. */
function untilLabel(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

function fmtWait(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/**
 * The block at the top of Today and Tasks (desktop and phone): what waits on the signed-in person. Nothing when nothing
 * does. `max` shows the first few; `seeAll` adds a "See all" link (the Needs page).
 */
export function NeedsYou({ needs, phone, max, seeAll }: { needs: Need[]; phone: boolean; max?: number; seeAll?: string }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const list = needs.filter(n => !gone.has(n.id));
  const shown = max ? list.slice(0, max) : list;
  // A push or a DM link opens /today#need-<ref>: scroll that card into view (both layouts exist in the page; take the visible one).
  useEffect(() => {
    const m = window.location.hash.match(/^#need-(\d+)$/);
    if (!m) return;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-need="${m[1]}"]`)].find(e => e.offsetParent !== null);
    el?.scrollIntoView({ block: 'start' });
  }, [needs.length]);
  if (!list.length) return null;
  return (
    <section data-section="needs-you" className={phone ? 'mt-3' : ''}>
      <div className={cn('flex items-center justify-between', phone ? 'px-1 mb-1.5' : 'mb-1.5')}>
        <h2 className={cn('font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400', phone ? 'text-[13px]' : 'text-xs')}>
          Needs you
          <span className="ml-1.5 font-normal text-muted-foreground">{list.length}</span>
        </h2>
        {seeAll && (
          <Link href={seeAll} data-needs-see-all className={cn('text-muted-foreground hover:text-foreground', phone ? 'inline-flex items-center min-h-11 -my-3 text-[13px]' : 'text-xs')}>
            See all ›
          </Link>
        )}
      </div>
      <div className="space-y-2">
        {shown.map(n => (
          <NeedCard key={n.id} need={n} phone={phone} onAnswered={id => setGone(g => new Set(g).add(id))} />
        ))}
      </div>
    </section>
  );
}

/** A project's Needs tab: open ones first (answerable when addressed to you), then the recently closed. */
export function NeedsTab({ needs }: { needs: Need[] }) {
  const { me } = useApp();
  const phone = usePhone();
  const open = needs.filter(n => n.status === 'open');
  const closed = needs.filter(n => n.status !== 'open');
  return (
    <div className="space-y-5 max-w-3xl" data-view="needs">
      <section className="space-y-2">
        <h2 className="px-1 md:px-0 text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Open · {open.length}</h2>
        {open.length === 0 && (
          <p className="text-sm text-muted-foreground px-1 md:px-0" data-needs-empty>
            Nothing is waiting on anyone in this project. When a Claude session or a teammate asks someone here to decide, approve or do something, or hands in work for review, it shows here.
          </p>
        )}
        <div className="space-y-2">{open.map(n => <NeedCard key={n.id} need={n} phone={phone} canAnswer={n.to === me} />)}</div>
      </section>
      {closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 md:px-0 text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recently closed</h2>
          <div className="space-y-2">{closed.map(n => <NeedCard key={n.id} need={n} phone={phone} canAnswer={false} />)}</div>
        </section>
      )}
    </div>
  );
}

/** The Needs page (/needs): what waits on the signed-in person, then what they answered in the last days. */
export function MyNeeds({ open, answered }: { open: Need[]; answered: Need[] }) {
  const phone = usePhone();
  const H2 = 'px-1 md:px-0 mb-1.5 text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';
  return (
    <div className="space-y-5" data-view="my-needs">
      <section>
        <h2 className={H2}>Waiting on you · {open.length}</h2>
        {open.length === 0 ? (
          <div data-needs-empty>
            <MEmpty
              icon={<HandHelping className="w-5 h-5" />}
              title="Nothing waits on you"
              hint="When a Claude session or a teammate needs you to decide, approve or do something, or hands in work for you to review, it shows here and on Today. You answer with a tap."
            />
          </div>
        ) : (
          <div className="space-y-2">{open.map(n => <NeedCard key={n.id} need={n} phone={phone} />)}</div>
        )}
      </section>
      {answered.length > 0 && (
        <section data-needs-answered>
          <h2 className={H2}>Answered recently</h2>
          <div className="space-y-2">{answered.map(n => <NeedCard key={n.id} need={n} phone={phone} canAnswer={false} />)}</div>
        </section>
      )}
    </div>
  );
}
