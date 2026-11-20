'use client';

import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { toast } from 'sonner';
import { HandHelping } from 'lucide-react';
import Link from '@/components/intent-link';
import { answerNeedAction } from '@/app/(app)/needs/actions';
import { actorLabel } from '@/lib/actors';
import { Ago } from './ago';
import { DeclutterList, DiskLines } from './declutter-list';
import type { Need } from '@/lib/data/needs';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';
import { usePhone } from './mobile/use-phone';
import { MEmpty } from './mobile/sub-header';
import { StatusBadge, type StatusKey } from './ui/status-badge';
import { Button } from './ui/button';
import { List, Row } from './ui/card';
import { Section } from './ui/section';

const KIND_LABEL: Record<Need['kind'], string> = { decide: 'Decide', approve: 'Approve', review: 'Review', do: 'Do', chase: 'Chase' };

/** Answering a Need: the toast and the declutter skip list live here, for the card and for the row's quick button. */
function useAnswerNeed(need: Need, text: string, ticked: Set<string>, onAnswered?: (id: string) => void) {
  const [pending, start] = useTransition();
  function answer(option: string) {
    start(async () => {
      const skip = need.declutter && option === 'yes' ? need.declutter.items.filter(i => !ticked.has(i.id)).map(i => i.id) : undefined;
      const r = await answerNeedAction(need.id, option, text.trim() || undefined, skip);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Need #${need.ref} answered`);
      onAnswered?.(need.id);
    });
  }
  return { answer, pending };
}

/** What a closed Need says: "Answered: Yes · filed #4 · waited 3 h", "Withdrawn by the asker" or "Replaced by a newer ask". */
function closedLine(need: Need): string {
  if (need.status === 'answered' && need.answer)
    return `Answered${need.answer.option ? ': ' + (need.options.find(o => o.id === need.answer!.option)?.label ?? (need.answer.option === 'other' ? 'own answer' : need.answer.option)) : ''}${need.filed?.length ? ` · filed ${need.filed.map(r => '#' + r).join(', ')}` : ''}${need.order?.applied ? ('v' in need.order.applied ? ` · applied as v${need.order.applied.v}` : ` · not applied: ${need.order.applied.error}`) : ''}${need.answer.text ? ` · "${need.answer.text}"` : ''}${need.waitedMs !== null ? ` · waited ${fmtWait(need.waitedMs)}` : ''}`;
  return need.status === 'withdrawn' ? 'Withdrawn by the asker' : 'Replaced by a newer ask';
}

/** One Need: who asked, the ask, an example, the options as buttons and a text box. Answerable only by the person it is addressed to. `inRow`: opened inside its NeedRow, which shows the meta line and the session. */
export function NeedCard({ need, phone, canAnswer = true, onAnswered, inRow = false }: { need: Need; phone: boolean; canAnswer?: boolean; onAnswered?: (id: string) => void; inRow?: boolean }) {
  const { people, me, projectName } = useApp();
  const [text, setText] = useState('');
  const open = need.status === 'open';
  const asker = actorLabel(need.from.actor, me, people);
  const project = projectName(need.projectId);
  // A declutter Need: every change starts ticked; what the person unticks goes with a Yes as `skip`.
  const [ticked, setTicked] = useState(() => new Set((need.declutter?.items ?? []).map(i => i.id)));
  const toggle = (id: string) => setTicked(t => (t.has(id) ? new Set([...t].filter(x => x !== id)) : new Set([...t, id])));
  const { answer, pending } = useAnswerNeed(need, text, ticked, onAnswered);

  return (
    <article
      data-need={inRow ? undefined : need.ref}
      data-need-status={inRow ? undefined : need.status}
      className={cn(inRow ? 'px-4 pb-4 pt-1 space-y-3' : cn('rounded-xl border bg-card', phone ? 'border-border/70 p-4 space-y-3' : 'border-border p-3 space-y-2'), !open && 'opacity-75')}
    >
      {!inRow && (
      <div className={cn('flex items-center gap-1.5 flex-wrap text-muted-foreground', phone ? 'text-[13px]' : 'text-xs')}>
        <HandHelping className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <span className="font-mono">Need #{need.ref}</span>
        <span>· {KIND_LABEL[need.kind]}</span>
        {project && <Link href={`/projects/${need.projectId}?tab=needs`} className="truncate max-w-[40vw] hover:text-foreground">· {project}</Link>}
        {need.taskRef && <Link href={`/tasks/${need.taskRef}`} className="hover:text-foreground">· on #{need.taskRef}</Link>}
        <span className="ml-auto"><Ago iso={need.createdAt} /></span>
      </div>
      )}
      {!inRow && need.session && <SessionChip session={need.session} />}
      <p className={cn('text-foreground leading-snug whitespace-pre-wrap break-words', phone ? 'text-[16px]' : 'text-sm')} data-need-ask={inRow ? undefined : ''}>
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
      {need.declutter && (open || need.declutter.result) && (
        <>
          <DeclutterList
            items={need.declutter.items}
            ticked={open && canAnswer ? ticked : undefined}
            onToggle={open && canAnswer ? toggle : undefined}
            result={need.declutter.result ? { applied: need.declutter.result.applied, failed: need.declutter.result.failed } : undefined}
            phone={phone}
          />
          <DiskLines lines={need.declutter.disk} phone={phone} />
        </>
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
          {closedLine(need)}
          {need.status === 'answered' && need.releaseUntil && (
            <ReleaseWindow iso={need.releaseUntil} />
          )}
        </p>
      )}
    </article>
  );
}

/** The session that asked, as it is now: "Payout export: waiting on you", "Payout export: Working". Opens it on the Claude page. */
function SessionChip({ session }: { session: NonNullable<Need['session']> }) {
  const status: StatusKey = session.state === 'waiting' ? 'Waiting on you' : session.state === 'working' ? 'Working' : session.state === 'off' ? 'Off' : session.state === 'on' ? 'On' : 'Idle';
  return (
    <Link href={session.href} className="flex max-w-full min-h-11 md:min-h-0 items-center -my-2 md:my-0" data-need-session={session.state} title="Open this session on the Claude page">
      <StatusBadge status={status} label={`${session.label}: ${session.word}`} className="max-w-full truncate block leading-5" />
    </Link>
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


/** The first line of an ask: what a folded Need shows. */
const firstLine = (ask: string) => ask.split('\n').find(l => l.trim())?.trim() ?? ask;

/**
 * One Need as one line inside a `List as="ul"`: the ask, `#ref · Kind · Project · session · ago`, and one button on the right.
 * A decide Need that is open and yours has its recommended answer as that button (answers at once, the toast says it);
 * every other open Need has Open / Fold. Tapping the line opens the full card in place.
 */
export function NeedRow({ need, canAnswer = true, onAnswered, defaultOpen = false }: { need: Need; canAnswer?: boolean; onAnswered?: (id: string) => void; defaultOpen?: boolean }) {
  const { projectName } = useApp();
  const phone = usePhone();
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = need.status === 'open';
  const first = need.options[0];
  const quick = isOpen && canAnswer && need.kind === 'decide' && !!first && !need.declutter;
  const { answer, pending } = useAnswerNeed(need, '', new Set(), onAnswered);
  const project = projectName(need.projectId);
  const meta = (
    <>
      <span className="font-mono">#{need.ref}</span> · {KIND_LABEL[need.kind]}
      {project ? ` · ${project}` : ''}
      {isOpen ? (need.session ? ` · ${need.session.label}: ${need.session.word}` : '') : ` · ${closedLine(need)}`} · <Ago iso={need.createdAt} />
    </>
  );
  return (
    <li data-need={need.ref} data-need-status={need.status} data-need-row>
      <Row
        className="pr-2"
        leading={<HandHelping className={cn('w-4 h-4', open && isOpen ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} aria-hidden />}
        title={<span data-need-ask>{firstLine(need.ask)}</span>}
        meta={meta}
        onClick={() => setOpen(o => !o)}
        trailing={
          quick ? (
            <Button size="touch" disabled={pending} data-need-quick={first.id} aria-label={`Answer #${need.ref}: ${first.label}`} onClick={() => answer(first.id)}>
              {first.label}
            </Button>
          ) : isOpen ? (
            <Button variant="ghost" size="touch" className="text-muted-foreground px-3" data-need-toggle aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} #${need.ref}`} onClick={() => setOpen(o => !o)}>
              {open ? 'Fold' : 'Open'}
            </Button>
          ) : undefined
        }
      />
      {open && <NeedCard need={need} phone={phone} inRow canAnswer={canAnswer} onAnswered={onAnswered} />}
    </li>
  );
}

const onHash = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
/** The Need a push or DM link points at (#need-<ref>), or null. */
const hashNeed = () => window.location.hash.match(/^#need-(\d+)$/)?.[1] ?? null;

/**
 * The block at the top of Today and Tasks (desktop and phone): what waits on the signed-in person, as one line each. Nothing
 * when nothing does. `max` shows the first few (3 by default); "See all" goes to the Needs page.
 */
export function NeedsYou({ needs, phone, max = 3 }: { needs: Need[]; phone: boolean; max?: number }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const hashRef = useSyncExternalStore(onHash, hashNeed, () => null);
  const list = needs.filter(n => !gone.has(n.id));
  // A push or a DM link opens /today#need-<ref>: that Need comes first, open, even when it was past the first few.
  const linked = hashRef ? list.find(n => String(n.ref) === hashRef) : undefined;
  const ordered = linked ? [linked, ...list.filter(n => n !== linked)] : list;
  const shown = ordered.slice(0, max);
  useEffect(() => {
    if (!hashRef) return;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-need="${hashRef}"]`)].find(e => e.offsetParent !== null);
    el?.scrollIntoView({ block: 'start' });
  }, [hashRef]);
  if (!list.length) return null;
  return (
    <div data-section="needs-you" className={phone ? 'mt-3' : ''}>
      <Section label="Needs you" count={list.length} seeAll={list.length > shown.length ? '/needs' : undefined}>
        <List as="ul">
          {shown.map(n => (
            <NeedRow key={n === linked ? `${n.id}-linked` : n.id} need={n} defaultOpen={n === linked} onAnswered={id => setGone(g => new Set(g).add(id))} />
          ))}
        </List>
      </Section>
    </div>
  );
}

/** A project's Needs tab: open ones first (answerable when addressed to you), then the recently closed. */
export function NeedsTab({ needs }: { needs: Need[] }) {
  const { me } = useApp();
  const open = needs.filter(n => n.status === 'open');
  const closed = needs.filter(n => n.status !== 'open');
  return (
    <div className="space-y-5 max-w-3xl" data-view="needs">
      <Section label="Open" count={open.length}>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground px-1 md:px-0" data-needs-empty>
            Nothing is waiting on anyone in this project. When a Claude session or a teammate asks someone here to decide, approve or do something, or hands in work for review, it shows here.
          </p>
        ) : (
          <List as="ul">{open.map(n => <NeedRow key={n.id} need={n} canAnswer={n.to === me} />)}</List>
        )}
      </Section>
      {closed.length > 0 && (
        <Section label="Recently closed">
          <List as="ul">{closed.map(n => <NeedRow key={n.id} need={n} canAnswer={false} />)}</List>
        </Section>
      )}
    </div>
  );
}

/** The Needs page (/needs): what waits on the signed-in person, then what they answered in the last days. */
export function MyNeeds({ open, answered }: { open: Need[]; answered: Need[] }) {
  return (
    <div className="space-y-5" data-view="my-needs">
      <Section label="Waiting on you" count={open.length}>
        {open.length === 0 ? (
          <div data-needs-empty>
            <MEmpty
              icon={<HandHelping className="w-5 h-5" />}
              title="Nothing waits on you"
              hint="When a Claude session or a teammate needs you to decide, approve or do something, or hands in work for you to review, it shows here and on Today. You answer with a tap."
            />
          </div>
        ) : (
          <List as="ul">{open.map(n => <NeedRow key={n.id} need={n} />)}</List>
        )}
      </Section>
      {answered.length > 0 && (
        <div data-needs-answered>
          <Section label="Answered recently">
            <List as="ul">{answered.map(n => <NeedRow key={n.id} need={n} canAnswer={false} />)}</List>
          </Section>
        </div>
      )}
    </div>
  );
}
