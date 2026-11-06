'use client';

import { useEffect, useState, useTransition } from 'react';
import { CalendarDays, Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { createCalendarLinkAction, getCalendarLinkAction, revokeCalendarLinkAction, rotateCalendarLinkAction } from './calendar-actions';
import { Row } from './device-settings';

const btn = 'inline-flex items-center justify-center gap-1.5 h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';
const quiet = cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60');
const loud = cn(btn, 'bg-foreground text-background hover:bg-foreground/90');

/**
 * Settings › Connections › Calendar (docs/calendar.md): a private link that Google Calendar, Outlook or Apple Calendar
 * subscribe to. The link is read back from the server for its owner (kept sealed there), so Copy works any time.
 */
export function CalendarSection({ initialOn }: { initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [pending, start] = useTransition();

  // An active link is read back from the server (sealed there, only for its owner), so Copy works any time, on any device.
  useEffect(() => {
    if (!initialOn) return;
    let live = true;
    getCalendarLinkAction().then(r => live && r.ok && r.url && setUrl(r.url));
    return () => {
      live = false;
    };
  }, [initialOn]);

  const run = (fn: () => ReturnType<typeof createCalendarLinkAction>, done: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setOn(r.url !== null);
      setUrl(r.url);
      setCopied(false);
      setConfirmOff(false);
      toast.success(done);
    });

  const copy = () =>
    navigator.clipboard?.writeText(url ?? '').then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy'),
    );

  return (
    <div data-calendar>
      <Row
        icon={<CalendarDays className="w-5 h-5 text-muted-foreground" />}
        title="Your tasks in your calendar"
        sub={on ? 'On. Tasks assigned to you or owned by you that have a start or due date.' : 'Off. Make a private link and add it to your calendar app. It only shows your own tasks, read-only.'}
        action={
          !on ? (
            <button type="button" data-calendar-create disabled={pending} onClick={() => run(createCalendarLinkAction, 'Calendar link made')} className={loud}>
              Create link
            </button>
          ) : undefined
        }
      />
      {on && !url && (
        <p className="px-4 pt-3 text-[13px] text-muted-foreground" data-calendar-nolink>Loading your link. If it does not appear, press Rotate for a new one.</p>
      )}
      {on && url && (
        <div className="px-4 py-3 space-y-2" data-calendar-fresh>
          <p className="text-[13px] text-muted-foreground">Anyone with this link can see your task titles, so keep it private. Rotate makes a new one and stops this one.</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input readOnly value={url} data-calendar-url aria-label="Calendar link" onFocus={e => e.currentTarget.select()} className="min-w-0 flex-1 h-11 md:h-9 rounded-lg border border-border bg-background px-3 text-[13px] font-mono" />
            <button type="button" data-calendar-copy onClick={copy} className={quiet}>
              {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {on && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3" data-calendar-manage>
          <button type="button" data-calendar-rotate disabled={pending} onClick={() => run(rotateCalendarLinkAction, 'New link made; the old one stopped working')} className={quiet}>
            Rotate
          </button>
          {confirmOff ? (
            <>
              <button type="button" data-calendar-off-confirm disabled={pending} onClick={() => run(revokeCalendarLinkAction, 'Calendar link turned off')} className={loud}>
                Turn off for good
              </button>
              <button type="button" onClick={() => setConfirmOff(false)} className={quiet}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" data-calendar-off disabled={pending} onClick={() => setConfirmOff(true)} className={quiet}>
              Turn off
            </button>
          )}
        </div>
      )}
      <div className="px-4 py-3 text-[13px] text-muted-foreground leading-relaxed space-y-1" data-calendar-help>
        <p><span className="text-foreground">Google Calendar:</span> on a computer, Other calendars (+) → From URL, paste the link. Phones follow the computer.</p>
        <p><span className="text-foreground">Outlook:</span> Add calendar → Subscribe from web, paste the link.</p>
        <p><span className="text-foreground">Apple Calendar:</span> File → New Calendar Subscription (Mac), or Settings → Calendar → Accounts → Add Subscribed Calendar (iPhone).</p>
        <p>Calendars refresh every few hours, so changes are not instant. Done and dropped tasks are left out.</p>
      </div>
    </div>
  );
}
