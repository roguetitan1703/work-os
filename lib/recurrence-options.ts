import type { Recurrence } from './types';

/** The repeat choices offered in forms (task page, New task form, phone task screen). */
export const RECURRENCE_OPTIONS: { label: string; value: Recurrence | null }[] = [
  { label: 'Never', value: null },
  { label: 'Daily', value: { freq: 'daily', interval: 1 } },
  { label: 'Weekdays', value: { freq: 'weekdays', interval: 1 } },
  { label: 'Weekly', value: { freq: 'weekly', interval: 1 } },
  { label: 'Every 2 weeks', value: { freq: 'weekly', interval: 2 } },
  { label: 'Monthly', value: { freq: 'monthly', interval: 1 } },
];

/** Short label for a recurrence, e.g. "Every 2 weeks". */
export function recurrenceLabel(r: { freq: Recurrence['freq']; interval?: number }): string {
  const o = RECURRENCE_OPTIONS.find(o => JSON.stringify(o.value) === JSON.stringify({ freq: r.freq, interval: r.interval ?? 1 }));
  if (o) return o.label;
  return `Every ${r.interval ?? 1} ${r.freq}`;
}
