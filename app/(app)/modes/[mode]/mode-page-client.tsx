'use client';

import { useState } from 'react';
import { Task, Mode } from '@/lib/types';
import { ModeConfig } from '@/lib/modes';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';
import { SubHeader } from '@/components/mobile/sub-header';

type FilterTab = 'Active' | 'All' | 'Done';

type Props = {
  modeName: string;
  modeConfig: ModeConfig;
  initialTasks: Task[];
};

export function ModePageClient({ modeName, modeConfig, initialTasks }: Props) {
  const [filter, setFilter] = useState<FilterTab>('Active');

  const filtered = initialTasks.filter(t => {
    if (filter === 'Active') return t.status !== 'Done' && t.status !== 'Dropped';
    if (filter === 'Done') return t.status === 'Done';
    return true;
  });
  const empty = filter === 'Done' ? 'Nothing finished in this mode yet.' : filter === 'Active' ? 'Nothing active in this mode. Add one above.' : 'No tasks in this mode yet.';

  return (
    <div className="space-y-5 md:space-y-6 max-w-5xl">
      <SubHeader title={modeName} subtitle={`${initialTasks.filter(t => t.status !== 'Done' && t.status !== 'Dropped').length} active`} />

      <div className="rounded-2xl md:rounded-xl p-4 md:p-5 border" style={{ backgroundColor: modeConfig.hex + '18', borderColor: modeConfig.hex + '40' }}>
        <div className="hidden md:flex items-center gap-2 mb-1">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: modeConfig.hex }} />
          <h1 className="text-xl font-bold" style={{ color: modeConfig.hex }}>
            {modeName}
          </h1>
        </div>
        <div className="md:hidden flex items-start gap-2.5">
          <span className="w-3 h-3 mt-1.5 rounded-full shrink-0" style={{ backgroundColor: modeConfig.hex }} />
          <p className="text-[15px] text-foreground/80">{modeConfig.description}</p>
        </div>
        <p className="hidden md:block text-sm text-foreground/70 max-w-2xl">{modeConfig.description}</p>
      </div>

      <QuickAddBar defaults={{ mode: modeName as Mode }} className="rounded-2xl md:rounded-lg border-border/70 md:border-border" />

      <div className="grid grid-cols-3 md:flex gap-1 bg-muted rounded-xl md:rounded-lg p-1 md:w-fit" role="tablist">
        {(['Active', 'All', 'Done'] as FilterTab[]).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={filter === tab}
            onClick={() => setFilter(tab)}
            className={`h-11 md:h-auto md:px-3 md:py-1 rounded-lg md:rounded text-sm font-medium transition-colors ${
              filter === tab ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <TaskList tasks={filtered} showMode={false} empty={empty} />
    </div>
  );
}
