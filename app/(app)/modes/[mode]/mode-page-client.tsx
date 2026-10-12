'use client';

import { useState } from 'react';
import { Task, Mode } from '@/lib/types';
import { ModeConfig } from '@/lib/modes';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';

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

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="rounded-xl p-5 border" style={{ backgroundColor: modeConfig.hex + '18', borderColor: modeConfig.hex + '40' }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: modeConfig.hex }} />
          <h1 className="text-xl font-bold" style={{ color: modeConfig.hex }}>
            {modeName}
          </h1>
        </div>
        <p className="text-sm text-foreground/70 max-w-2xl">{modeConfig.description}</p>
      </div>

      <QuickAddBar defaults={{ mode: modeName as Mode }} />

      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {(['Active', 'All', 'Done'] as FilterTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              filter === tab ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <TaskList tasks={filtered} showMode={false} />
    </div>
  );
}
