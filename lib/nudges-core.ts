import { presenceState, type StateRow } from './data/presence-state';

// Nudges, the pure half (note ce434ed759; the database half is lib/data/nudges.ts). No database: the clock rules and the text.

export const NUDGE = { idleMin: 20, /** Minutes to wait after the 1st, 2nd and 3rd nudge of the day before the next. */ gapsMin: [60, 120, 240], perDay: 4 } as const;

export type NudgeRow = StateRow & { dispatched?: unknown; promptAt?: Date | null; nudgeAt?: Date | null; nudgeCount?: number; nudgeDay?: string };

/** The day a nudge is counted in (UTC, YYYY-MM-DD). */
export const nudgeDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * May the clock allow an idle nudge for this row now? Idle (a hook reported the stop) for NUDGE.idleMin minutes since the later of
 * the stop and the last prompt, not a dispatched run, under 4 today, and the gap after the last nudge (1 h after the first, 2 h
 * after the second, 4 h after the third) is over. `count` is today's nudges so far.
 */
export function nudgeTimeOk(row: NudgeRow, now: number): { ok: boolean; idleMin: number; day: string; count: number } {
  const day = nudgeDay(now);
  const count = row.nudgeDay === day ? row.nudgeCount ?? 0 : 0;
  const no = { ok: false, idleMin: 0, day, count };
  if (row.dispatched || !row.activity || row.endedAt) return no;
  const st = presenceState(row, { now }).state;
  if (st !== 'idle' && st !== 'on') return no;
  const since = Math.max(row.activity.at.getTime(), row.promptAt?.getTime() ?? 0);
  const idleMin = (now - since) / 60_000;
  if (idleMin < NUDGE.idleMin) return no;
  if (count >= NUDGE.perDay) return no;
  if (count > 0 && row.nudgeAt) {
    const gap = NUDGE.gapsMin[Math.min(count, NUDGE.gapsMin.length) - 1];
    if ((now - row.nudgeAt.getTime()) / 60_000 < gap) return no;
  }
  return { ok: true, idleMin: Math.floor(idleMin), day, count };
}

/** A Next line as the nudge quotes it: one line, no control characters, no frame markers, no double quotes, cut at `max` with an ellipsis. */
export function nudgeLine(text: string, max = 120): string {
  const t = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\[\[/g, '[ [')
    .replace(/\]\]/g, '] ]')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

/** The idle nudge's words (the lines are already cleaned and cut). */
export function nudgeText(idleMin: number, lines: string[]): string {
  return `Work OS: idle ${idleMin} min. Not waiting on anyone: ${lines.map(l => `"${l}"`).join('; ')}. Do the next one. If it really waits on someone, add \`waits_on\` to the line (save_state edit) and stop; that ends these nudges for it.`;
}
