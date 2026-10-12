'use client';

import { PRIORITIES, STATUSES, type Priority, type Status } from '@/lib/types';
import { PRIORITY_TEXT, STATUS_TEXT } from '@/lib/format';
import { cn } from '@/lib/utils';

const base =
  'h-6 rounded-md border border-transparent bg-transparent px-1 text-xs font-medium outline-none hover:border-border focus-visible:border-ring cursor-pointer disabled:opacity-50 [&>option]:text-foreground [&>option]:bg-popover';

export function StatusSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Status;
  onChange: (s: Status) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      aria-label="Status"
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as Status)}
      onClick={e => e.stopPropagation()}
      className={cn(base, STATUS_TEXT[value], 'no-underline', className)}
    >
      {STATUSES.map(s => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

export function PrioritySelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Priority;
  onChange: (p: Priority) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      aria-label="Priority"
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as Priority)}
      onClick={e => e.stopPropagation()}
      className={cn(base, 'font-mono', PRIORITY_TEXT[value], className)}
    >
      {PRIORITIES.map(p => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}
