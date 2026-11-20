'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { HandHelping, Link2, MessageSquare, MonitorUp, RotateCcw, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Link from '@/components/intent-link';
import { NeedCard } from '@/components/needs';
import { usePhone } from '@/components/mobile/use-phone';
import { Button } from '@/components/ui/button';
import { List, Row } from '@/components/ui/card';
import { ConfirmSheet, Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { badgeOf, clockOf, ORIGIN_LABEL, type SessionItem } from '@/lib/session-item';
import type { Need } from '@/lib/data/needs';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { openInVscodeAction, removeSessionAction, resumeSessionAction, stopSessionAction, unhideSessionAction } from '@/app/(app)/projects/[id]/launcher-actions';
import { messageSessionAction } from '@/app/(app)/claude/message-actions';
import { write } from '@/app/(app)/claude/auto-refresh';
import { trackJob } from '@/app/(app)/claude/job-toast';
import { LinkSessionFolder } from '@/app/(app)/claude/link-session-folder';

// The one session row (docs/HANDOVER.md section 8, "Sessions"): the Claude page, a project page and Today's Claude card.
// State, label, what it is on, project, computer, where it runs, and its last line; one control on the right, chosen by
// state: Answer (waiting on you: its Need opens in place), Message (the viewer's own working, on or idle session: a
// request its hook hands over at its next tool call), Resume (ended, with a project). A tap on the row opens the
// session's sheet: everything about it and every other action (Stop, Resume, Open in VS Code, Link, Remove).
// Data: lib/session-item.ts.

type Where = 'claude' | 'project' | 'today';
type Action = 'link' | 'vscode' | 'resume' | 'stop' | 'remove';
type Trail = 'answer' | 'message' | 'resume';

const ACTION: Record<Action, { text: string; icon: React.ReactNode }> = {
  link: { text: 'Link to a project', icon: <Link2 /> },
  vscode: { text: 'Open in VS Code', icon: <MonitorUp /> },
  resume: { text: 'Resume', icon: <RotateCcw /> },
  stop: { text: 'Stop', icon: <Square /> },
  remove: { text: 'Remove', icon: <Trash2 /> },
};
const TRAIL: Record<Trail, { text: string; icon: React.ReactNode }> = {
  answer: { text: 'Answer', icon: <HandHelping /> },
  message: { text: 'Message', icon: <MessageSquare /> },
  resume: { text: 'Resume', icon: <RotateCcw /> },
};

const isLive = (s: SessionItem) => s.state !== 'off' && s.state !== 'failed';
/** The list is a container (SessionList): its rows switch to columns when it is wide, whatever page it sits on. */
const WIDE_HIDE = '@2xl:hidden';

/** The row's one control, by state. Message only on the viewer's own sessions that the roster lists (its id is their presence row). */
function trailOf(s: SessionItem, need?: Need): Trail | null {
  // An open Need to the viewer comes first, even while the session works on beside it: the answer is what it waits for.
  if (need && isLive(s)) return 'answer';
  if (s.state === 'waiting' && s.ask && s.mine && s.worker) return 'message'; // its turn ended with a question: a message answers it (and wakes it)
  if (s.state === 'waiting') return null; // a permission prompt: nothing in Work OS answers it
  if (s.mine && s.worker && (s.state === 'working' || s.state === 'idle' || s.state === 'quiet')) return 'message';
  if (!isLive(s) && s.project && s.control?.canResume) return 'resume';
  return null;
}

/** Every other action on a session, for its sheet. Open in VS Code only for a session that runs in VS Code. */
function actionsOf(s: SessionItem): Action[] {
  const c = s.control;
  if (!c) return [];
  const out: Action[] = [];
  if (c.canResume) out.push('resume');
  if (c.canStop) out.push('stop');
  if (c.origin === 'vscode' && c.canVscode) out.push('vscode');
  if (!c.projectId && c.folderKey) out.push('link');
  if (c.canRemove) out.push('remove');
  return out;
}

function ariaOf(a: Action, s: SessionItem): string {
  const t = s.label;
  if (a === 'link') return `Link ${s.control?.folder ?? t} to a project`;
  if (a === 'vscode') return `Open ${t} in VS Code`;
  return `${ACTION[a].text} ${t}`;
}

/**
 * A list of sessions: rows, the session sheet and the confirms. `serves` (project page): the Next line each session's task serves, by
 * item id. `asks`: the open Needs to the viewer by asking session id (need-sessions.ts asksBySession), for Answer.
 */
export function SessionList({
  items,
  tz,
  where,
  serves,
  asks,
  openId,
  className,
  ...rest
}: {
  items: SessionItem[];
  tz: string;
  where: Where;
  serves?: Record<string, string>;
  asks?: Record<string, Need>;
  openId?: string;
  className?: string;
} & { [k: `data-${string}`]: string | number | boolean | undefined }) {
  const router = useRouter();
  const phone = usePhone();
  const [open, setOpen] = useState<string | null>(openId && items.some(i => i.id === openId) ? openId : null);
  const [stopping, setStopping] = useState<SessionItem | null>(null);
  const [linking, setLinking] = useState<SessionItem | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<SessionItem | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (s: SessionItem, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: (data?: unknown) => void) => {
    setBusy(s.id);
    try {
      const r = await write(fn);
      if (!r.ok) return void toast.error(r.error ?? 'Failed');
      done?.(r.data);
      router.refresh();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const act = (a: Action, s: SessionItem) => {
    const c = s.control!;
    if (a === 'link') {
      setOpen(null); // the picker takes the sheet's place
      return setLinking(s);
    }
    if (a === 'stop') return setStopping(s);
    if (a === 'vscode') return call(s, () => openInVscodeAction(c.deviceId, c.key.slice(c.deviceId.length + 1)), id => void trackJob(id as string, `Opening ${s.label} in VS Code…`, 'Opened in VS Code'));
    if (a === 'resume') return call(s, () => resumeSessionAction(c.controlProjectId!, c.workOsId!), () => toast('Resuming…'));
    return call(
      s,
      () => removeSessionAction(c.controlProjectId!, c.workOsId!),
      () => {
        setOpen(null);
        setGone(g => new Set(g).add(s.id));
        toast('Removed from the list', {
          action: {
            label: 'Undo',
            onClick: () => {
              write(() => unhideSessionAction(c.controlProjectId!, c.workOsId!)).then(r => {
                if (!r.ok) return void toast.error(r.error);
                setGone(g => new Set([...g].filter(x => x !== s.id)));
                router.refresh();
              });
            },
          },
        });
      },
    );
  };

  const trail = (t: Trail, s: SessionItem) => {
    setOpen(null);
    if (t === 'answer') return setAnswering(s.id);
    if (t === 'message') return setMessaging(s);
    return act('resume', s);
  };

  // A session waiting on a Need to the viewer says so, whatever its hook knew.
  const shown = items.filter(i => !gone.has(i.id)).map(i => (i.state === 'waiting' && asks?.[i.id] ? { ...i, word: 'Waiting on you' } : i));
  const sheet = open ? shown.find(i => i.id === open) : undefined;
  const need = answering ? asks?.[answering] : undefined;
  return (
    <>
      <List as="ul" className={cn('@container', className)} {...rest}>
        {shown.map(s => (
          <SessionRow key={s.id} s={s} tz={tz} where={where} serves={serves?.[s.id]} trail={trailOf(s, asks?.[s.id])} busy={busy === s.id} onOpen={() => setOpen(s.id)} onTrail={t => trail(t, s)} />
        ))}
      </List>
      {sheet && <SessionSheet s={sheet} tz={tz} trail={trailOf(sheet, asks?.[sheet.id])} busy={busy === sheet.id} onAct={a => act(a, sheet)} onTrail={t => trail(t, sheet)} onClose={() => setOpen(null)} />}
      {need && answering && (
        <Sheet title={`Need #${need.ref}`} onClose={() => setAnswering(null)}>
          <div className="pb-2" data-answer-sheet={answering}>
            <NeedCard
              need={need}
              phone={phone}
              onAnswered={() => {
                setAnswering(null);
                router.refresh();
              }}
            />
          </div>
        </Sheet>
      )}
      {messaging && <MessageSheet s={messaging} onClose={() => setMessaging(null)} onSent={() => router.refresh()} />}
      {linking?.control?.folderKey && <LinkSessionFolder folderKey={linking.control.folderKey} deviceId={linking.control.deviceId} folder={linking.control.folder} onClose={() => setLinking(null)} />}
      {stopping?.control && (
        <ConfirmSheet
          title="Stop session"
          message={
            <>
              Stop &ldquo;{stopping.label}&rdquo; in {stopping.control.folder} on {stopping.control.deviceName}? Its terminal closes; you can resume it later.
            </>
          }
          verb="Stop"
          danger
          pending={busy === stopping.id}
          onConfirm={() =>
            call(
              stopping,
              () => stopSessionAction(stopping.control!.controlProjectId!, stopping.control!.workOsId!),
              () => {
                toast(`Stopping ${stopping.label}…`);
                setStopping(null);
                setOpen(null);
              },
            )
          }
          onClose={() => setStopping(null)}
        />
      )}
    </>
  );
}

/** The state badge: the state's word and its dot (components/ui/status-badge.tsx). Long words (a repo to trust, a clone) go to the meta line instead. */
function Badge({ s, split }: { s: SessionItem; split?: boolean }) {
  const key = badgeOf(s.state, s.word);
  if (s.word.length > 24) return <StatusBadge status={key} data-worker-state label={key} />;
  const [head, rest] = wordParts(s.word);
  // `split` (a row): the badge says the state only; the rest ("3 subagents") leads the phone's subline and sits under the badge from md.
  return <StatusBadge status={key} data-worker-state label={split && rest ? head : s.word} />;
}

/** "Working · 3 subagents" -> ["Working", "3 subagents"]. */
const wordParts = (w: string): [string, string] => {
  const i = w.indexOf(' · ');
  return i < 0 ? [w, ''] : [w.slice(0, i), w.slice(i + 3)];
};

/** The subline's time: "since 14:02" for idle and waiting (when that began), "last active 2 days ago" for quiet and ended sessions, nothing while it works. */
function TimeOf({ s, tz }: { s: SessionItem; tz: string }) {
  if (s.since)
    return (
      <span data-worker-since suppressHydrationWarning>
        since {clockOf(s.since, tz)}
      </span>
    );
  if ((s.state === 'quiet' || !isLive(s)) && s.lastActiveAt)
    return (
      <span data-session-last-active suppressHydrationWarning>
        last active {fmtAgo(s.lastActiveAt)}
      </span>
    );
  return null;
}

function SessionRow({
  s,
  tz,
  where,
  serves,
  trail,
  busy,
  onOpen,
  onTrail,
}: {
  s: SessionItem;
  tz: string;
  where: Where;
  serves?: string;
  trail: Trail | null;
  busy: boolean;
  onOpen: () => void;
  onTrail: (t: Trail) => void;
}) {
  const c = s.control;
  const long = s.word.length > 24;
  const rest = long ? '' : wordParts(s.word)[1];
  const hasTime = !!(s.since || s.state === 'quiet' || (!isLive(s) && s.lastActiveAt));
  // Stacked (a phone, a narrow list): one subline. "3 subagents" and the time lead, where it runs trails. In a wide list those move
  // to the where-it-runs and state columns (aside), so the subline keeps what it is on: the question, person, task, project.
  const lead: React.ReactNode[] = [];
  if (rest) lead.push(<span key="r" data-word-rest>{rest}</span>);
  if (hasTime) lead.push(<TimeOf key="t" s={s} tz={tz} />);
  const mid: React.ReactNode[] = [];
  if (long) mid.push(<span key="w">{s.word}</span>);
  if (s.ask)
    mid.push(
      <span key="q" className="text-foreground/80" data-session-ask title="The question its turn ended with, written by the agent">
        {s.ask}
      </span>,
    );
  if (s.person) mid.push(<span key="who" data-worker-person>{s.person}</span>);
  if (s.doing)
    mid.push(
      <span key="d" className="text-foreground/80" data-worker-doing data-session-doing data-lane-task={where === 'project' && s.doing.ref ? '' : undefined}>
        {s.doing.text}
        {!s.doing.held && (
          <span className="ml-1.5 text-destructive" data-unheld>
            unheld
          </span>
        )}
      </span>,
    );
  if (serves) mid.push(<span key="n" data-lane-serves>{serves}</span>);
  if (where !== 'project') mid.push(<span key="p" data-session-project={s.project ? undefined : 'none'}>{s.project?.name ?? 'No project'}</span>);
  if (c?.error)
    mid.push(
      <span key="e" data-session-error title={c.error}>
        {c.error}
      </span>,
    );
  const origin = s.origin ? (
    <span
      data-origin={s.origin}
      data-origin-badge={s.origin === 'vscode' ? '' : undefined}
      data-dispatched={s.origin === 'workos' ? '' : undefined}
      title={s.origin === 'workos' ? 'Started from Work OS for a task: it runs on its own key, so it opens with Resume' : undefined}
    >
      {ORIGIN_LABEL[s.origin]}
    </span>
  ) : null;
  const account = s.account ? <span data-session-account>{s.account}</span> : null;
  const tail: React.ReactNode[] = [];
  if (s.machine) tail.push(<span key="m">{s.machine}</span>);
  if (account) tail.push(<span key="acct">{account}</span>);
  if (origin) tail.push(<span key="o">{origin}</span>);
  const sep = ' · ';
  const meta =
    lead.length || mid.length || tail.length ? (
      <>
        {lead.map((m, i) => (
          <span key={`l${i}`} className={WIDE_HIDE}>
            {m}
            {(i < lead.length - 1 || mid.length > 0 || tail.length > 0) && sep}
          </span>
        ))}
        {mid.map((m, i) => (
          <span key={`m${i}`}>
            {i > 0 && sep}
            {m}
          </span>
        ))}
        {tail.map((m, i) => (
          <span key={`t${i}`} className={WIDE_HIDE}>
            {(i > 0 || mid.length > 0) && sep /* after lead, lead's own separator stands */}
            {m}
          </span>
        ))}
      </>
    ) : undefined;
  const join = (xs: React.ReactNode[]) =>
    xs.filter(Boolean).map((x, i) => (
      <span key={i}>
        {i > 0 && sep}
        {x}
      </span>
    ));
  const under = [rest ? <span key="r" data-word-rest>{rest}</span> : null, hasTime ? <TimeOf key="t" s={s} tz={tz} /> : null].filter(Boolean);
  const below = [account, origin].filter(Boolean);
  // A wide list (WIDE, over 672px: the Claude page from a laptop up): where it runs (computer; account · app) and the state (badge;
  // "3 subagents", the time) as fixed columns, like the task rows'. A narrower list (a phone, a project page's column, Today's card) stacks.
  const aside = (
    <span className="hidden @2xl:flex shrink-0 items-center gap-4 self-center">
      <span className="w-[180px] min-w-0 text-meta leading-snug" data-session-where>
        <span className="block truncate text-foreground/80">{s.machine || '\u00a0'}</span>
        <span className="block truncate text-muted-foreground">{below.length ? join(below) : '\u00a0'}</span>
      </span>
      <span className="w-[170px] min-w-0 flex flex-col items-end text-right text-meta leading-snug" data-session-state-col>
        <Badge s={s} split />
        {under.length > 0 && <span className="block max-w-full truncate text-muted-foreground mt-0.5">{join(under)}</span>}
      </span>
    </span>
  );
  return (
    <Row
      as="li"
      className={cn(s.depth === 1 && 'pl-8 bg-muted/20', 'pr-2')}
      data-worker={s.worker}
      data-depth={s.worker ? s.depth : undefined}
      data-state={s.state}
      data-session-row={c?.key}
      data-session={c?.workOsId}
      data-project-worker={where === 'project' && s.worker ? s.worker : undefined}
      onClick={onOpen}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate font-medium" data-session-label>
            {s.label}
          </span>
          <span className={cn(WIDE_HIDE, 'shrink-0 flex')}>
            <Badge s={s} split />
          </span>
        </span>
      }
      meta={meta}
      aside={aside}
      detail={
        // With no task, the doing line already is the last result: not twice.
        s.last && !(s.doing && !s.doing.ref) ? (
          <span className="italic" data-lane-result title="Written by the agent, not checked">
            last: {s.last.text.replace(/\s+/g, ' ')}
          </span>
        ) : undefined
      }
      trailing={
        // In a wide list the button has a column of its own, held open on rows without one, so the columns line up.
        trail ? (
          <span className="flex justify-end @2xl:w-[104px]">
          <Button
            variant="ghost"
            size="touch"
            className="text-muted-foreground px-3"
            disabled={busy}
            onClick={() => onTrail(trail)}
            aria-label={`${TRAIL[trail].text} ${s.label}`}
            data-session-action={trail}
          >
            {TRAIL[trail].icon}
            {TRAIL[trail].text}
          </Button>
          </span>
        ) : (
          <span className="hidden @2xl:block @2xl:w-[104px]" aria-hidden />
        )
      }
    />
  );
}

/** Message one of the viewer's own sessions: a request its hook hands over at its next tool call (messages.ts messageOwnSession). */
function MessageSheet({ s, onClose, onSent }: { s: SessionItem; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const send = async () => {
    setPending(true);
    try {
      const r = await write(() => messageSessionAction(s.worker!, text));
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Sent to ${s.label}`, r.note ? { description: r.note } : undefined);
      onClose();
      onSent();
    } catch {
      toast.error('Something went wrong');
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet title={`Message ${s.label}`} onClose={onClose}>
      <form
        className="space-y-3 pb-2"
        data-message-sheet={s.id}
        onSubmit={e => {
          e.preventDefault();
          if (text.trim()) void send();
        }}
      >
        <p className="text-meta text-muted-foreground">It reaches the session at its next step, as a request from you.</p>
        <Textarea value={text} onChange={e => setText(e.target.value)} rows={4} maxLength={4000} autoFocus aria-label={`Message to ${s.label}`} data-message-input />
        <Button type="submit" size="touch" disabled={pending || !text.trim()} data-message-send>
          <MessageSquare />
          Send
        </Button>
      </form>
    </Sheet>
  );
}

/** Everything about one session and every action on it. */
function SessionSheet({
  s,
  tz,
  trail,
  busy,
  onAct,
  onTrail,
  onClose,
}: {
  s: SessionItem;
  tz: string;
  trail: Trail | null;
  busy: boolean;
  onAct: (a: Action) => void;
  onTrail: (t: Trail) => void;
  onClose: () => void;
}) {
  const c = s.control;
  const facts: [string, React.ReactNode][] = [];
  if (s.person) facts.push(['Person', s.personName]);
  if (s.via) facts.push(['Client', s.via]);
  if (s.account) facts.push(['Account', s.account]);
  if (s.machine) facts.push(['Computer', s.machine]);
  if (s.branch) facts.push(['Branch', s.branch]);
  if (s.slot) facts.push(['Slot', `slot ${s.slot}`]);
  if (c?.folder) facts.push(['Folder', c.folder]);
  if (s.subagents) facts.push(['Subagents', String(s.subagents)]);
  if (s.origin && s.origin !== 'workos') facts.push(['Runs in', ORIGIN_LABEL[s.origin]]);
  if (c?.workOs) facts.push(['Started', c.dispatched ? 'From Work OS, for a task (opens with Resume)' : 'From Work OS']);
  if (s.lastActiveAt) facts.push(['Last active', <span key="a" suppressHydrationWarning>{fmtAgo(s.lastActiveAt)}</span>]);
  if (c?.error) facts.push(['Error', c.error]);
  const actions = actionsOf(s);
  return (
    <Sheet title={s.label} onClose={onClose}>
      <div className="space-y-4 pb-2" data-session-sheet={s.id}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge s={s} />
          <span className="text-meta text-muted-foreground">
            <TimeOf s={s} tz={tz} />
          </span>
          {s.word.length > 24 && <span className="text-meta text-muted-foreground">{s.word}</span>}
        </div>
        <dl className="space-y-1 text-meta">
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 text-muted-foreground">Project</dt>
            <dd className="min-w-0">{s.project ? <Link href={`/projects/${encodeURIComponent(s.project.id)}`} className="underline-offset-2 hover:underline">{s.project.name}</Link> : 'No project'}</dd>
          </div>
          {s.doing && (
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-muted-foreground">Doing</dt>
              <dd className="min-w-0 break-words">
                {s.doing.ref ? <Link href={`/tasks/${s.doing.ref}`} className="underline-offset-2 hover:underline">{s.doing.text}</Link> : s.doing.text}
                {!s.doing.held && <span className="ml-1.5 text-destructive">unheld</span>}
              </dd>
            </div>
          )}
          {facts.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {s.last && (
          <div className="rounded-control bg-muted/50 px-3 py-2 space-y-1 text-meta break-words" data-session-last>
            <p className="italic">last: {s.last.text}</p>
            <p className="text-label text-muted-foreground" data-lane-result-by>
              written by {s.via || 'the agent'} of {s.personName || 'you'}, not checked
            </p>
          </div>
        )}
        {(actions.length > 0 || (trail && trail !== 'resume')) && (
          <div className="flex flex-wrap gap-2">
            {trail && trail !== 'resume' && (
              <Button size="touch" disabled={busy} onClick={() => onTrail(trail)} aria-label={`${TRAIL[trail].text} ${s.label}`} data-sheet-action={trail}>
                {TRAIL[trail].icon}
                {TRAIL[trail].text}
              </Button>
            )}
            {actions.map(a => (
              <Button
                key={a}
                variant="outline"
                size="touch"
                disabled={busy}
                onClick={() => onAct(a)}
                aria-label={ariaOf(a, s)}
                title={a === 'link' ? 'This folder is not filed under a project' : undefined}
                data-sheet-action={a}
                data-open-vscode={a === 'vscode' ? '' : undefined}
                data-link-folder={a === 'link' ? '' : undefined}
              >
                {ACTION[a].icon}
                {ACTION[a].text}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
