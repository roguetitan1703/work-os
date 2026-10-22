import Link from 'next/link';
import { SCHEDULE } from '@/lib/schedule';
import { getBlockColor } from '@/lib/modes';
import { todayStr, weekday } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { SubHeader } from '@/components/mobile/sub-header';
import { requireCaller } from '@/lib/caller';
import { isOperator } from '@/lib/operator';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
type Day = (typeof DAYS)[number];
const DAY_LABELS: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };

type Props = { searchParams: Promise<{ day?: string }> };

export const metadata = { title: 'Schedule · Work OS' };

export default async function SchedulePage({ searchParams }: Props) {
  const sp = await searchParams;
  const dow = weekday(todayStr()); // 0 = Sun
  const todayKey: Day | null = dow >= 1 && dow <= 5 ? DAYS[dow - 1] : null;
  const day: Day = (DAYS as readonly string[]).includes(sp.day ?? '') ? (sp.day as Day) : (todayKey ?? 'mon');
  // The built-in schedule is Om's own week: until each person has their own (phase 3), only the operator sees it.
  if (!isOperator(await requireCaller())) {
    return (
      <div className="space-y-6" data-schedule-empty>
        <SubHeader title="Schedule" />
        <h1 className="hidden md:block text-2xl font-bold text-foreground">Schedule</h1>
        <p className="text-[15px] md:text-sm text-muted-foreground px-1 md:px-0">No schedule yet. Your own weekly schedule is coming in a later update.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SubHeader title="Schedule" subtitle="Saturday and Sunday are flex days" />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Mon–Fri schedule. Saturday and Sunday are flex days.</p>
      </div>

      {/* Phone: one day at a time */}
      <div className="md:hidden space-y-4">
        <div className="grid grid-cols-5 gap-1 rounded-xl bg-muted p-1">
          {DAYS.map(d => (
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
              {DAY_LABELS[d]}
              {todayKey === d && <span className="mt-1 w-1 h-1 rounded-full bg-blue-500" />}
            </Link>
          ))}
        </div>
        <div className="rounded-2xl bg-card border border-border/70 divide-y divide-border/60 overflow-hidden">
          {SCHEDULE.map((blk, i) => {
            const modeName = blk.modes[day];
            const color = getBlockColor(modeName);
            return (
              <div key={i} className="flex gap-3 px-4 py-3">
                <div className="w-[3.75rem] shrink-0 pt-0.5">
                  <div className="font-mono text-[13px] text-foreground tabular-nums">{blk.start}</div>
                  <div className="font-mono text-[12px] text-muted-foreground tabular-nums">{blk.end}</div>
                </div>
                <div className="w-1 shrink-0 rounded-full" style={{ backgroundColor: color.hex }} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[16px] font-medium text-foreground">{blk.block}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{blk.duration}</span>
                  </div>
                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: color.hex + '25', color: color.hex }}>
                    {modeName}
                  </span>
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
              {DAYS.map(d => (
                <th key={d} className="px-3 py-2 text-center">{DAY_LABELS[d]}</th>
              ))}
              <th className="px-3 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {SCHEDULE.map((blk, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {blk.start}–{blk.end}
                </td>
                <td className="px-3 py-2 font-medium text-foreground">{blk.block}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{blk.duration}</td>
                {DAYS.map(d => {
                  const modeName = blk.modes[d];
                  const color = getBlockColor(modeName);
                  return (
                    <td key={d} className="px-2 py-1.5 text-center">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
                        style={{ backgroundColor: color.hex + '25', color: color.hex }}
                      >
                        {modeName}
                      </span>
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
