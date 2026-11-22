'use client';

import { HandHelping } from 'lucide-react';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';

/** "Needs Om: <ask>" in place of a task's percent when it has an open Need (docs/archive/plan-1-3.md slice 4). Nothing otherwise. */
export function NeedChip({ task, className }: { task: Pick<Task, 'need'>; className?: string }) {
  const { people } = useApp();
  const n = task.need;
  if (!n) return null;
  const name = (people[n.to] ?? 'someone').split(' ')[0];
  return (
    <span
      data-need-chip={n.ref}
      title={`Needs ${people[n.to] ?? 'someone'}: ${n.ask}`}
      className={cn('inline-flex items-center gap-1 min-w-0 text-amber-700 dark:text-amber-400', className)}
    >
      <HandHelping className="w-3 h-3 shrink-0" aria-hidden />
      <span className="truncate">
        Needs {name}: {n.ask}
      </span>
    </span>
  );
}
