'use client';

import { useTransition } from 'react';
import Link from '@/components/intent-link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { WEEKDAYS, type ScheduleBlock } from '@/lib/schedule';
import { saveScheduleAction } from './actions';

const btn = 'h-11 md:h-9 px-4 rounded-full md:rounded-md text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';

/** One block, 9 to 5, Monday to Friday: a start for someone who just wants Today to know their working hours. */
const NINE_TO_FIVE: ScheduleBlock = { start: '09:00', end: '17:00', block: 'Work', modes: Object.fromEntries(WEEKDAYS.map(d => [d, 'Work'])) as ScheduleBlock['modes'], notes: '' };

/** The empty Schedule page's two ways in: the 9 to 5 preset (saved at once, editable after) or the editor. */
export function SchedulePreset() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const use = () =>
    start(async () => {
      const r = await saveScheduleAction([NINE_TO_FIVE], { Work: '#3b82f6' });
      if (!r.ok) return void toast.error(r.error);
      toast.success('Schedule set to 9 to 5, Monday to Friday. Edit it any time.');
      router.refresh();
    });
  return (
    <div className="flex flex-wrap gap-2" data-schedule-preset>
      <button type="button" onClick={use} disabled={pending} className={`${btn} bg-foreground text-background`} data-use-nine-to-five>
        Use 9 to 5 weekdays
      </button>
      <Link href="/timetable?edit=1" className={`${btn} border border-border text-foreground hover:bg-muted`} data-edit-schedule>
        Set up my own
      </Link>
    </div>
  );
}
