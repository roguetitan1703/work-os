import { addDays } from './dates';
import type { Status } from './types';

// The calendar feed's text (docs/calendar.md): RFC 5545, all-day events only. Pure: no database, no clock.

export type FeedTask = { id: string; ref: number; title: string; status: Status; priority: 'P1' | 'P2' | 'P3' | 'P4'; due: string | null; start: string | null; updatedAt: Date };

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const day = (s: string) => s.replace(/-/g, '');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const PRIORITY = { P1: 1, P2: 5, P3: 5, P4: 9 } as const;

/** Lines longer than 75 octets are folded (CRLF + space), never inside a multi-byte character. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** The first and last day (inclusive) an event covers: start..due, else the one date; a start after the due is ignored. */
export function eventDays(t: Pick<FeedTask, 'due' | 'start'>): { from: string; to: string } | null {
  const { due, start } = t;
  if (due && start && start < due) return { from: start, to: due };
  const one = due ?? start;
  return one ? { from: one, to: one } : null;
}

export function buildIcs(tasks: FeedTask[], o: { baseUrl: string; tz: string; now: Date }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Delpat//Work OS//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Work OS tasks', `X-WR-TIMEZONE:${o.tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT4H', 'X-PUBLISHED-TTL:PT4H'];
  for (const t of tasks) {
    const d = eventDays(t);
    if (!d) continue;
    const url = `${o.baseUrl}/tasks/${t.ref}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@work-os`,
      `DTSTAMP:${stamp(o.now)}`,
      `LAST-MODIFIED:${stamp(t.updatedAt)}`,
      `DTSTART;VALUE=DATE:${day(d.from)}`,
      `DTEND;VALUE=DATE:${day(addDays(d.to, 1))}`,
      `SUMMARY:${esc(`#${t.ref} ${t.title}`)}`,
      `DESCRIPTION:${esc(`Status: ${t.status}\n${url}`)}`,
      `URL:${url}`,
      `PRIORITY:${PRIORITY[t.priority]}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
