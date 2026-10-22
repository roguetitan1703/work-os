'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { saveTimeSettingsAction } from './profile-actions';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const select = 'h-11 md:h-9 rounded-md border border-border bg-background px-2 text-sm';

/** Your timezone (what "today" and alert hours mean for you) and quiet hours (alerts wait until they end). */
export function TimeSettings({ timezone, quietStart, quietEnd }: { timezone: string; quietStart: number; quietEnd: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tz, setTz] = useState(timezone);
  const [qs, setQs] = useState(quietStart);
  const [qe, setQe] = useState(quietEnd);
  const zones = useMemo(() => {
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf('timeZone');
    } catch {}
    return all.includes(timezone) ? all : [timezone, ...all];
  }, [timezone]);
  const browser = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  }, []);
  const dirty = tz !== timezone || qs !== quietStart || qe !== quietEnd;

  return (
    <form
      className="space-y-3"
      data-time-settings
      onSubmit={e => {
        e.preventDefault();
        start(async () => {
          const r = await saveTimeSettingsAction({ timezone: tz, quietStart: qs, quietEnd: qe });
          if (!r.ok) return void toast.error(r.error);
          toast.success('Saved');
          router.refresh();
        });
      }}
    >
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-28 text-muted-foreground">Timezone</span>
        <select value={tz} onChange={e => setTz(e.target.value)} className={select} name="timezone">
          {zones.map(z => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        {browser && browser !== tz && (
          <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setTz(browser)}>
            Use this device&apos;s ({browser})
          </button>
        )}
      </label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-28 text-muted-foreground">Quiet hours</span>
        <select value={qs} onChange={e => setQs(Number(e.target.value))} className={select} aria-label="Quiet hours start" name="quietStart">
          {HOURS.map(h => (
            <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
          ))}
        </select>
        <span>to</span>
        <select value={qe} onChange={e => setQe(Number(e.target.value))} className={select} aria-label="Quiet hours end" name="quietEnd">
          {HOURS.map(h => (
            <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{qs === qe ? 'none' : 'nothing is sent; it waits until they end'}</span>
      </div>
      <button type="submit" disabled={pending || !dirty} className="h-11 md:h-9 px-4 rounded-full text-sm font-semibold border border-border disabled:opacity-50" data-save-time>
        Save
      </button>
    </form>
  );
}
