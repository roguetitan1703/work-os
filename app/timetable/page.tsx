import { SCHEDULE } from '@/lib/schedule';
import { getBlockColor } from '@/lib/modes';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };

export default function TimetablePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Timetable</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Mon–Fri schedule. Saturday and Sunday are flex days.</p>
      </div>

      <div className="border rounded overflow-auto">
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
