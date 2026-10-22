import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { colorOf } from '@/lib/modes';
import { WEEKDAYS, WEEKDAY_LABELS, durationLabel, weekdayKey, type Wd } from '@/lib/schedule';
import { todayStr, weekday } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { SubHeader } from '@/components/mobile/sub-header';
import { requireCaller } from '@/lib/caller';
import { getSchedule } from '@/lib/user-schedule';
import { getOrgModes } from '@/lib/org-modes';
import { ScheduleEditor } from './schedule-editor';

type Props = { searchParams: Promise<{ day?: string; edit?: string }> };

export const metadata = { title: 'Schedule · Work OS' };

/** The signed-in person's own week (lib/schedule.ts). ?edit=1 opens the editor. */
export default async function SchedulePage({ searchParams }: Props) {
  const sp = await searchParams;
  const me = await requireCaller();
  const [schedule, modes] = await Promise.all([getSchedule(me), getOrgModes(me.orgId)]);
  const todayKey = weekdayKey(weekday(todayStr(me.tz)));
  const day: Wd = (WEEKDAYS as readonly string[]).includes(sp.day ?? '') ? (sp.day as Wd) : (todayKey ?? 'mon');
  const color = (name: string) => colorOf(name, modes, schedule.colors);
  const blocks = schedule.blocks;

  if (sp.edit === '1') {
    return (
      <div className="space-y-6">
        <SubHeader title="Edit schedule" back="/timetable" backLabel="Schedule" />
        <h1 className="hidden md:block text-2xl font-bold text-foreground">Edit schedule</h1>
        <ScheduleEditor initialBlocks={blocks} initialRoutine={schedule.routine} modes={modes.map(m => m.name)} extraNames={Object.keys(schedule.colors)} />
      </div>
    );
  }

  const edit = (
    <Link href="/timetable?edit=1" className="inline-flex items-center gap-1.5 h-11 md:h-8 px-3 rounded-lg border border-border text-sm md:text-xs text-foreground hover:bg-muted" data-edit-schedule>
      <Pencil className="w-3.5 h-3.5" /> {blocks.length ? 'Edit' : 'Set up your schedule'}
    </Link>
  );

  if (!blocks.length) {
    return (
      <div className="space-y-6" data-schedule-empty>
        <SubHeader title="Schedule" />
        <h1 className="hidden md:block text-2xl font-bold text-foreground">Schedule</h1>
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">
          No schedule yet. Add your week&apos;s time blocks (Monday to Friday) and Today shows the block you are in and its tasks.
        </p>
        <div className="px-1 md:px-0">{edit}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SubHeader title="Schedule" subtitle="Saturday and Sunday are flex days" />
      <div className="hidden md:flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Mon–Fri schedule ({me.tz}). Saturday and Sunday are flex days.</p>
        </div>
        {edit}
      </div>

      {/* Phone: one day at a time */}
      <div className="md:hidden space-y-4">
        <div className="flex justify-end">{edit}</div>
        <div className="grid grid-cols-5 gap-1 rounded-xl bg-muted p-1">
          {WEEKDAYS.map(d => (
            <Link
              key={d}
              href={`/timetable?day=${d}`}
              replace
              scroll={false}
              className={cn(
                'h-11 flex flex-col items-center justify-center rounded-lg text-sm font-medium leading-none',
                day === d ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground',
              )}
            >
              {WEEKDAY_LABELS[d]}
              {todayKey === d && <span className="mt-1 w-1 h-1 rounded-full bg-blue-500" />}
            </Link>
          ))}
        </div>
        <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {blocks.map((blk, i) => {
            const modeName = blk.modes[day];
            const c = color(modeName);
            return (
              <div key={i} className="flex gap-3 px-4 py-3">
                <div className="w-[3.75rem] shrink-0 pt-0.5">
                  <div className="font-mono text-[13px] text-foreground tabular-nums">{blk.start}</div>
                  <div className="font-mono text-[12px] text-muted-foreground tabular-nums">{blk.end}</div>
                </div>
                <div className="w-1 shrink-0 rounded-full" style={{ backgroundColor: c.hex }} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[16px] font-medium text-foreground">{blk.block}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{durationLabel(blk)}</span>
                  </div>
                  {modeName && (
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: c.hex + '25', color: c.hex }}>
                      {modeName}
                    </span>
                  )}
                  {blk.notes && <p className="text-sm text-muted-foreground">{blk.notes}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="hidden md:block border rounded overflow-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-muted text-xs text-muted-foreground uppercase sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left whitespace-nowrap">Time</th>
              <th className="px-3 py-2 text-left">Block</th>
              <th className="px-3 py-2 text-left">Duration</th>
              {WEEKDAYS.map(d => (
                <th key={d} className="px-3 py-2 text-center">{WEEKDAY_LABELS[d]}</th>
              ))}
              <th className="px-3 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((blk, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {blk.start}–{blk.end}
                </td>
                <td className="px-3 py-2 font-medium text-foreground">{blk.block}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{durationLabel(blk)}</td>
                {WEEKDAYS.map(d => {
                  const modeName = blk.modes[d];
                  const c = color(modeName);
                  return (
                    <td key={d} className="px-2 py-1.5 text-center">
                      {modeName && (
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap" style={{ backgroundColor: c.hex + '25', color: c.hex }}>
                          {modeName}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-muted-foreground text-xs max-w-xs">{blk.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
